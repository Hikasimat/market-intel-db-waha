package webrtc

import (
	"log/slog"
	"sync/atomic"

	"wacalls/internal/voip/media"

	pionWebRTC "github.com/pion/webrtc/v4"
)

// PCMChannelLabel is the data channel label carrying raw 16 kHz mono Int16 LE PCM.
const PCMChannelLabel = "pcm"

// Bridge carries raw PCM between the browser and the CallManager over a WebRTC data channel.
type Bridge struct {
	pc  *pionWebRTC.PeerConnection
	dc  atomic.Pointer[pionWebRTC.DataChannel]
	log *slog.Logger

	// OnBrowserPCM is invoked with 16 kHz mono PCM captured from the browser mic.
	OnBrowserPCM func(pcm []float32)
	// OnTerminalICE fires when the WebRTC ICE connection fails or closes.
	OnTerminalICE func()
}

// NewBridge creates a new WebRTC PeerConnection answering the browser's offer.
func NewBridge(offerSDP string, stunServers []string, log *slog.Logger) (*Bridge, string, error) {
	if log == nil {
		log = slog.Default()
	}

	var ices []pionWebRTC.ICEServer
	for _, s := range stunServers {
		if s != "" {
			ices = append(ices, pionWebRTC.ICEServer{URLs: []string{s}})
		}
	}
	if len(ices) == 0 {
		ices = []pionWebRTC.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		}
	}

	pc, err := pionWebRTC.NewPeerConnection(pionWebRTC.Configuration{
		ICEServers: ices,
	})
	if err != nil {
		return nil, "", err
	}
	br := &Bridge{pc: pc, log: log}

	pc.OnDataChannel(func(dc *pionWebRTC.DataChannel) {
		if dc.Label() != PCMChannelLabel {
			return
		}
		br.dc.Store(dc)
		dc.OnMessage(func(msg pionWebRTC.DataChannelMessage) {
			if cb := br.OnBrowserPCM; cb != nil && len(msg.Data) > 0 {
				cb(media.PCMInt16LEToFloat32(msg.Data))
			}
		})
	})

	pc.OnICEConnectionStateChange(func(s pionWebRTC.ICEConnectionState) {
		log.Debug("browser ice state", "state", s.String())
		if s == pionWebRTC.ICEConnectionStateFailed || s == pionWebRTC.ICEConnectionStateClosed {
			if br.OnTerminalICE != nil {
				br.OnTerminalICE()
			}
		}
	})

	if err := pc.SetRemoteDescription(pionWebRTC.SessionDescription{Type: pionWebRTC.SDPTypeOffer, SDP: offerSDP}); err != nil {
		pc.Close()
		return nil, "", err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	gatherComplete := pionWebRTC.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, "", err
	}
	<-gatherComplete

	return br, pc.LocalDescription().SDP, nil
}

// WritePCM sends 16 kHz mono float32 PCM to the browser as Int16 LE over the data channel.
func (b *Bridge) WritePCM(pcm []float32) error {
	dc := b.dc.Load()
	if dc == nil || len(pcm) == 0 {
		return nil
	}
	return dc.Send(media.PCMFloat32ToInt16LE(pcm))
}

// Close releases the WebRTC peer connection.
func (b *Bridge) Close() {
	if b.pc != nil {
		_ = b.pc.Close()
	}
}


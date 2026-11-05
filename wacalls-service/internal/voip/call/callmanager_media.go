package call

import (
	"time"
	"wacalls/internal/voip/core"
	"wacalls/internal/voip/media"
	"wacalls/internal/voip/transport"
)

func (m *CallManager) initCodec() {
	if m.codec != nil {
		return
	}
	codec, err := media.NewMLowCodec(media.DefaultCodecOptions)
	if err != nil {
		m.log.Warn("MLow codec unavailable — call will run signaling-only (no audio)", "err", err)
		return
	}
	m.codec = codec
}

func (m *CallManager) FeedCapturedPCM(data []float32) {
	m.mu.Lock()
	defer m.mu.Unlock()

	isActive := m.currentCall != nil && m.currentCall.StateData.State == core.CallStateActive
	ready := isActive && m.codec != nil && m.rtpSession != nil && m.srtpSession != nil && m.relay.HasConnection()
	if !ready {
		// Buffer incoming microphone audio so early speech is not dropped while call is connecting/ringing.
		// Limit preBuffer to 32,000 samples (2 seconds at 16kHz).
		const maxPreBuffer = 32000
		if len(m.preBuffer)+len(data) > maxPreBuffer {
			excess := (len(m.preBuffer) + len(data)) - maxPreBuffer
			if excess < len(m.preBuffer) {
				m.preBuffer = m.preBuffer[excess:]
			} else {
				m.preBuffer = nil
			}
		}
		m.preBuffer = append(m.preBuffer, data...)
		return
	}

	var allData []float32
	if len(m.preBuffer) > 0 {
		allData = append(m.preBuffer, data...)
		m.preBuffer = nil
	} else {
		allData = data
	}

	m.lastCaptureAt = time.Now()
	frameSize := m.codec.FrameSize()
	if m.encodeBuf == nil {
		m.encodeBuf = make([]float32, frameSize)
		m.encodeBufPos = 0
	}

	offset := 0
	for offset < len(allData) {
		toCopy := min(len(allData)-offset, frameSize-m.encodeBufPos)
		copy(m.encodeBuf[m.encodeBufPos:], allData[offset:offset+toCopy])
		m.encodeBufPos += toCopy
		offset += toCopy
		if m.encodeBufPos < frameSize {
			break
		}
		frame := make([]float32, frameSize)
		copy(frame, m.encodeBuf)
		m.encodeBufPos = 0

		opus, err := m.codec.Encode(frame)
		if err != nil {
			m.log.Debug("encode error", "err", err)
			continue
		}
		m.sendOpusFrameLocked(opus)
	}
}

func (m *CallManager) sendOpusFrameLocked(opus []byte) {
	if m.rtpSession == nil || m.srtpSession == nil {
		return
	}
	marker := !m.firstPacketSent
	pkt := m.rtpSession.CreatePacketWithDuration(opus, m.codec.FrameSize(), marker)
	if m.debeEnabled {
		pkt.Header.Extension = true
		pkt.Header.ExtensionProfile = 0xbede
		pkt.Header.ExtensionData = nil
	}
	m.firstPacketSent = true

	srtp, err := m.srtpSession.Protect(pkt)
	if err != nil {
		m.log.Debug("srtp protect error", "err", err)
		return
	}
	m.relay.Broadcast(srtp)

	m.outAudioPackets++
	if m.outAudioPackets%100 == 1 {
		m.log.Info("[CALL] Caller audio transmission active", "packets_sent", m.outAudioPackets)
	}
	if !m.bidiLogged && m.inAudioPackets > 0 && m.outAudioPackets > 0 {
		m.bidiLogged = true
		m.log.Info("[CALL] Bidirectional media verified", "in_packets", m.inAudioPackets, "out_packets", m.outAudioPackets)
	}
}

func (m *CallManager) startSilenceKeepaliveLocked() {
	if m.keepaliveStop != nil || m.codec == nil {
		return
	}
	stop := make(chan struct{})
	m.keepaliveStop = stop
	frameSize := m.codec.FrameSize()
	go func() {
		ticker := time.NewTicker(60 * time.Millisecond)
		defer ticker.Stop()
		silence := make([]float32, frameSize)
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				m.mu.Lock()
				isActive := m.currentCall != nil && m.currentCall.StateData.State == core.CallStateActive
				ready := isActive && m.codec != nil && m.rtpSession != nil && m.srtpSession != nil && m.relay.HasConnection()
				idle := time.Since(m.lastCaptureAt) > 120*time.Millisecond
				if ready && idle {
					if opus, err := m.codec.Encode(silence); err == nil {
						m.sendOpusFrameLocked(opus)
					}
				}
				m.mu.Unlock()
			}
		}
	}()
}

func (m *CallManager) onRelayData(data []byte) {
	if transport.IsStunPacket(data) {
		return
	}
	if !transport.IsRtpPacket(data) {
		return
	}
	if len(data) < 12 {
		return
	}
	pt := data[1] & 0x7f
	if pt != core.PayloadTypeWhatsAppOpus && pt != 111 {
		return
	}

	m.mu.Lock()
	if m.srtpSession == nil || m.codec == nil {
		m.mu.Unlock()
		return
	}
	ssrc := uint32(data[8])<<24 | uint32(data[9])<<16 | uint32(data[10])<<8 | uint32(data[11])
	if ssrc == m.selfSsrc {
		m.mu.Unlock()
		return
	}
	if !m.actualPeerSet {
		m.actualPeerSet = true
		if !containsSsrc(m.peerSsrcs, ssrc) {
			m.peerSsrcs = []uint32{ssrc}
			m.relay.SetSubscriptionSsrc(ssrc)
			go m.relay.ResendSubscriptions()
		}
	}
	srtp := m.srtpSession
	codec := m.codec

	m.inAudioPackets++
	inCount := m.inAudioPackets
	outCount := m.outAudioPackets
	shouldLogBidi := !m.bidiLogged && inCount > 0 && outCount > 0
	if shouldLogBidi {
		m.bidiLogged = true
	}
	m.mu.Unlock()

	if inCount%100 == 1 {
		m.log.Info("[CALL] Recipient audio reception active", "packets_received", inCount, "ssrc", ssrc)
	}
	if shouldLogBidi {
		m.log.Info("[CALL] Bidirectional media verified", "in_packets", inCount, "out_packets", outCount)
	}

	pkt, err := srtp.Unprotect(data)
	if err != nil {
		m.log.Debug("srtp unprotect error", "err", err)
		return
	}
	if len(pkt.Payload) == 0 {
		return
	}
	pcm, err := codec.Decode(pkt.Payload)
	if err != nil {
		return
	}
	pcm = media.NormalizeFrame(pcm, codec.FrameSize())
	if m.OnPeerAudio != nil {
		m.OnPeerAudio(pcm)
	}
}

package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"wacalls/internal/voip/call"
	"wacalls/internal/voip/core"
	"wacalls/internal/voip/signaling"
	"wacalls/internal/voip/wanode"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

// Session represents one WAHA (Baileys) WhatsApp session whose socket is bridged
// into the calling engine. It does not own a WhatsApp connection.
type Session struct {
	id   string
	name string
	mgr  *SessionManager
	log  *slog.Logger

	reg *callRegistry

	mu   sync.Mutex
	sock core.VoipSocket
	jid  string
	auth AuthSnapshot
}

func newSession(mgr *SessionManager, id, name string, sock core.VoipSocket, jid string) *Session {
	return &Session{
		id:   id,
		name: name,
		mgr:  mgr,
		log:  mgr.log.With("session", id),
		sock: sock,
		jid:  jid,
		auth: AuthSnapshot{State: "open", Paired: true},
		reg:  newCallRegistry(),
	}
}

// update swaps the bridged socket (e.g. after a Baileys reconnect) without dropping the session.
func (s *Session) update(sock core.VoipSocket, jid string) {
	s.mu.Lock()
	s.sock = sock
	s.jid = jid
	s.mu.Unlock()
	s.setAuth(AuthSnapshot{State: "open", Paired: true})
}

func (s *Session) socket() core.VoipSocket {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sock
}

func (s *Session) connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.auth.Paired && s.sock != nil
}

func (s *Session) createCall(callID string) *call.CallManager {
	cm := call.NewCallManager(s.socket(), s.log)
	s.wireCall(cm, callID)
	s.reg.add(callID, &activeCall{cm: cm})
	return cm
}

func (s *Session) wireCall(cm *call.CallManager, callID string) {
	cm.OnIncoming = func(c *call.CallInfo) {
		s.mgr.broker.upsertCall(CallRecord{
			SessionID: s.id, CallID: c.CallID, Direction: "inbound", Peer: c.PeerJid,
			StartedAt: time.Now().UnixMilli(), Status: StatusRinging,
		})
		s.mgr.broker.emitIncoming(s.id, c.CallID, c.PeerJid)
	}
	cm.OnStateChange = func(c *call.CallInfo) {
		if c.IsEnded() {
			s.removeCall(c.CallID)
			s.mgr.broker.endCall(c.CallID, string(c.StateData.EndReason))
			return
		}
		dir := "outbound"
		if c.Direction == core.CallDirectionIncoming {
			dir = "inbound"
		}
		existing, _ := s.mgr.broker.getCall(c.CallID)
		rec := CallRecord{
			SessionID: s.id, CallID: c.CallID, Direction: dir, Peer: c.PeerJid,
			StartedAt: time.Now().UnixMilli(), Status: mapStatus(c.StateData.State),
		}
		if existing != nil {
			rec.Owner = existing.Owner
			rec.StartedAt = existing.StartedAt
		}
		s.mgr.broker.upsertCall(rec)
	}
	cm.OnEnded = func(c *call.CallInfo) {
		s.removeCall(c.CallID)
		s.mgr.broker.endCall(c.CallID, string(c.StateData.EndReason))
	}
	cm.OnPeerAudio = func(pcm16 []float32) {
		ac, ok := s.reg.get(callID)
		if !ok || ac.bridge == nil {
			return
		}
		_ = ac.bridge.WritePCM(pcm16)
	}
}

func (s *Session) startOutgoing(ctx context.Context, peer types.JID, isVideo bool) (string, error) {
	callID := signaling.GenerateCallID()
	cm := s.createCall(callID)
	if err := cm.StartCall(ctx, callID, peer, isVideo); err != nil {
		s.removeCall(callID)
		return "", err
	}
	return callID, nil
}

func (s *Session) callForEvent(from types.JID, id string, data *waBinary.Node) (*activeCall, bool) {
	callID := callIDFromNode(wrapCall(from, id, data))
	if callID == "" {
		return nil, false
	}
	return s.reg.get(callID)
}

func (s *Session) onIncomingOffer(ctx context.Context, from types.JID, id string, data *waBinary.Node) {
	node := wrapCall(from, id, data)
	callID := callIDFromNode(node)
	if callID == "" {
		return
	}
	if max := s.mgr.maxCalls; max > 0 && s.reg.count() >= max {
		s.rejectOffer(ctx, node, from)
		return
	}
	cm := s.createCall(callID)
	cm.HandleCallOffer(ctx, node, from)
}

func (s *Session) rejectOffer(ctx context.Context, node *waBinary.Node, from types.JID) {
	info := signaling.ExtractNodeInfo(node)
	if info == nil {
		return
	}
	creator := wanode.AttrString(info.InnerNode.Attrs, "call-creator")
	if creator == "" {
		creator = from.String()
	}
	reject := signaling.BuildRejectStanza(from, info.CallID, wanode.MustJID(creator))
	_ = s.socket().SendNode(ctx, reject)
	s.log.Info("inbound call rejected: session at capacity", "call_id", info.CallID)
}

// handleCallEvent dispatches a raw WhatsApp call stanza (forwarded by the Baileys socket).
// kind is the child tag of the <call> node: offer, preaccept, accept, transport, terminate, reject.
func (s *Session) handleCallEvent(kind string, from types.JID, id string, data *waBinary.Node) {
	ctx := context.Background()
	switch kind {
	case "offer":
		s.onIncomingOffer(ctx, from, id, data)
	case "receipt:offer", "preaccept":
		// Both preaccept and receipt:offer from the remote peer indicate that the
		// recipient's device has received the offer and is showing the incoming call screen (ringing).
		if ac, ok := s.callForEvent(from, id, data); ok {
			ac.cm.HandleCallPreaccept(ctx, wrapCall(from, id, data), from)
		}
	case "receipt:accept", "accept":
		if ac, ok := s.callForEvent(from, id, data); ok {
			ac.cm.HandleCallAccept(ctx, wrapCall(from, id, data), from)
		}
	case "transport":
		if ac, ok := s.callForEvent(from, id, data); ok {
			ac.cm.HandleCallTransport(ctx, wrapCall(from, id, data), from)
		}
	case "receipt:terminate", "receipt:reject", "terminate", "reject":
		if ac, ok := s.callForEvent(from, id, data); ok {
			ac.cm.HandleCallTerminate(wrapCall(from, id, data))
		}
	default:
		s.log.Debug("ignoring unknown call event kind", "kind", kind, "from", from.String())
	}
}

func (s *Session) setAuth(a AuthSnapshot) {
	s.mu.Lock()
	s.auth = a
	s.mu.Unlock()
	s.mgr.broker.emitAuthState(s.id, a)
	s.mgr.broker.emitSessionList(s.mgr.infos())
}

func (s *Session) info() SessionInfo {
	s.mu.Lock()
	a := s.auth
	jid := s.jid
	s.mu.Unlock()
	return SessionInfo{ID: s.id, Name: s.name, JID: jid, State: a.State, Paired: a.Paired}
}

func (s *Session) setBridge(callID string, b AudioBridge) {
	oldB, found := s.reg.setBridge(callID, b)
	if !found {
		if b != nil {
			b.Close()
		}
		return
	}
	if oldB != nil && oldB != b {
		oldB.Close()
	}
}

func (s *Session) removeCall(callID string) {
	ac, ok := s.reg.remove(callID)
	if !ok {
		return
	}
	if ac.bridge != nil {
		ac.bridge.Close()
	}
}

func (s *Session) terminateCall(callID string, reason core.EndCallReason) {
	ac, ok := s.reg.get(callID)
	if !ok {
		return
	}
	_ = ac.cm.EndCall(context.Background(), reason)
}

func (s *Session) teardownAllCalls() {
	for _, ac := range s.reg.drain() {
		_ = ac.cm.EndCall(context.Background(), core.EndCallReasonUserEnded)
		if ac.bridge != nil {
			ac.bridge.Close()
		}
	}
}

// disconnect is invoked when the underlying Baileys session closes.
func (s *Session) disconnect() {
	s.teardownAllCalls()
	s.setAuth(AuthSnapshot{State: "disconnected", Paired: false})
}

func (s *Session) shutdown() {
	s.teardownAllCalls()
}

func mapStatus(state core.CallState) CallStatus {
	switch state {
	case core.CallStateActive:
		return StatusConnected
	case core.CallStateEnded, core.CallStateRejected, core.CallStateBusy, core.CallStateFailed, core.CallStateTimeout:
		return StatusEnded
	case core.CallStateRemoteRinging, core.CallStateIncomingRinging:
		return StatusRinging
	case core.CallStateInitiating, core.CallStateOfferSent, core.CallStateServerAcknowledged, core.CallStateRemoteAccepted, core.CallStateMediaConnecting:
		return StatusStarting
	default:
		return StatusStarting
	}
}

package session

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"wacalls/internal/core"
	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/providers/native"
	"wacalls/internal/voip/call"
	voipCore "wacalls/internal/voip/core"
	"wacalls/internal/voip/signaling"
	"wacalls/internal/voip/wanode"
	"wacalls/internal/webrtc"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

type activeCall struct {
	callID    string
	sessionID string
	tenantID  string
	peer      string
	direction string
	startedAt int64
	status    string
	owner     *string
	cm        *call.CallManager
	bridge    *webrtc.Bridge
	wsBridge  *webrtc.WSBridge
}

// Engine coordinates VoIP calling across providers and browser WebRTC bridges.
type Engine struct {
	mu          sync.RWMutex
	activeCalls map[string]*activeCall // key: callID
	providers   *providers.Registry
	store       *Store
	broker      *events.Broker
	log         *slog.Logger
	maxCalls    int
	stunServers []string
}

// NewEngine constructs a new Universal Calling Engine.
func NewEngine(reg *providers.Registry, store *Store, broker *events.Broker, maxCalls int, stunServers []string, log *slog.Logger) *Engine {
	if log == nil {
		log = slog.Default()
	}
	return &Engine{
		activeCalls: make(map[string]*activeCall),
		providers:   reg,
		store:       store,
		broker:      broker,
		log:         log.With("component", "calling_engine"),
		maxCalls:    maxCalls,
		stunServers: stunServers,
	}
}

// StanzaReceiver is implemented by providers that receive WhatsApp call stanzas.
type StanzaReceiver interface {
	SetCallHandlers(
		onOffer func(ctx context.Context, from types.JID, node *waBinary.Node),
		onAccept func(ctx context.Context, from types.JID, node *waBinary.Node),
		onTransport func(ctx context.Context, from types.JID, node *waBinary.Node),
		onTerminate func(ctx context.Context, from types.JID, node *waBinary.Node),
		onAck func(ctx context.Context, node *waBinary.Node),
	)
}

// AttachProvider wires VoIP stanza handlers for an authenticated provider.
func (e *Engine) AttachProvider(p core.WhatsAppProvider) {
	if nat, ok := p.(*native.NativeProvider); ok {
		nat.OnIncomingOffer = func(ctx context.Context, from types.JID, node *waBinary.Node) {
			e.handleInboundOffer(ctx, p.TenantID(), p.ID(), from, node, nat)
		}
		nat.OnIncomingAccept = func(ctx context.Context, from types.JID, node *waBinary.Node) {
			e.forwardCallStanza(node, func(ac *activeCall) {
				ac.cm.HandleCallAccept(ctx, node, from)
			})
		}
		nat.OnIncomingTransport = func(ctx context.Context, from types.JID, node *waBinary.Node) {
			e.forwardCallStanza(node, func(ac *activeCall) {
				ac.cm.HandleCallTransport(ctx, node, from)
			})
		}
		nat.OnIncomingTerminate = func(ctx context.Context, from types.JID, node *waBinary.Node) {
			e.forwardCallStanza(node, func(ac *activeCall) {
				ac.cm.HandleCallTerminate(node)
			})
		}
	} else if rcv, ok := p.(StanzaReceiver); ok {
		rcv.SetCallHandlers(
			func(ctx context.Context, from types.JID, node *waBinary.Node) {
				e.handleInboundOffer(ctx, p.TenantID(), p.ID(), from, node, p)
			},
			func(ctx context.Context, from types.JID, node *waBinary.Node) {
				e.forwardCallStanza(node, func(ac *activeCall) {
					ac.cm.HandleCallAccept(ctx, node, from)
				})
			},
			func(ctx context.Context, from types.JID, node *waBinary.Node) {
				e.forwardCallStanza(node, func(ac *activeCall) {
					ac.cm.HandleCallTransport(ctx, node, from)
				})
			},
			func(ctx context.Context, from types.JID, node *waBinary.Node) {
				e.forwardCallStanza(node, func(ac *activeCall) {
					ac.cm.HandleCallTerminate(node)
				})
			},
			func(ctx context.Context, node *waBinary.Node) {
				e.HandleAck(ctx, node)
			},
		)
	}
}

func (e *Engine) forwardCallStanza(node *waBinary.Node, fn func(*activeCall)) {
	callID := callIDFromNode(node)
	if callID == "" {
		return
	}
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if ok {
		fn(ac)
	}
}

func (e *Engine) HandleAck(ctx context.Context, node *waBinary.Node) {
	e.mu.RLock()
	calls := make([]*activeCall, 0, len(e.activeCalls))
	for _, ac := range e.activeCalls {
		calls = append(calls, ac)
	}
	e.mu.RUnlock()
	for _, ac := range calls {
		ac.cm.HandleCallAck(ctx, node)
	}
}

func (e *Engine) handleInboundOffer(ctx context.Context, tenantID, sessionID string, from types.JID, node *waBinary.Node, p core.WhatsAppProvider) {
	info := signaling.ExtractNodeInfo(node)
	if info == nil {
		return
	}
	callID := info.CallID
	if callID == "" {
		e.log.Error("inbound call rejected: call-id missing from offer node", "from", from.String())
		return
	}

	e.mu.RLock()
	activeCount := len(e.activeCalls)
	e.mu.RUnlock()

	if e.maxCalls > 0 && activeCount >= e.maxCalls {
		e.log.Warn("inbound call rejected: capacity exceeded", "call_id", callID)
		creator := wanode.AttrString(info.InnerNode.Attrs, "call-creator")
		if creator == "" {
			creator = from.String()
		}
		reject := signaling.BuildRejectStanza(from, callID, wanode.MustJID(creator))
		if sock, err := p.GetVoipSocket(); err == nil {
			_ = sock.SendNode(ctx, reject)
		}
		return
	}

	sock, err := p.GetVoipSocket()
	if err != nil {
		e.log.Error("cannot get voip socket for incoming call", "err", err)
		return
	}

	cm := call.NewCallManager(sock, e.log)
	ac := &activeCall{
		callID:    callID,
		sessionID: sessionID,
		tenantID:  tenantID,
		peer:      from.String(),
		direction: "inbound",
		startedAt: time.Now().UnixMilli(),
		cm:        cm,
	}

	e.mu.Lock()
	e.activeCalls[callID] = ac
	e.mu.Unlock()

	e.wireCallManager(ac)
	cm.HandleCallOffer(ctx, node, from)
}

func (e *Engine) wireCallManager(ac *activeCall) {
	callID := ac.callID
	cm := ac.cm

	cm.OnIncoming = func(c *call.CallInfo) {
		ac.status = "ringing"
		rec := core.CallRecord{
			CallID:    callID,
			SessionID: ac.sessionID,
			TenantID:  ac.tenantID,
			Direction: "inbound",
			Peer:      c.PeerJid,
			StartedAt: ac.startedAt,
			Status:    "ringing",
		}
		_ = e.store.UpsertCall(context.Background(), rec)
		e.broker.Publish(core.NewEvent(core.EventCallIncoming, ac.sessionID, callID, ac.tenantID, map[string]any{
			"id":        callID,
			"callId":    callID,
			"peer":      c.PeerJid,
			"offeredAt": ac.startedAt,
		}))
		e.broker.Publish(core.NewEvent(core.EventCallStatus, ac.sessionID, callID, ac.tenantID, map[string]any{
			"id":        callID,
			"callId":    callID,
			"owner":     ac.owner,
			"status":    "ringing",
			"peer":      c.PeerJid,
			"startedAt": ac.startedAt,
			"call":      rec,
		}))
		e.broker.Publish(core.NewEvent(core.EventCallList, "", "", ac.tenantID, map[string]any{
			"calls": e.ListCalls(ac.tenantID, ""),
		}))
	}

	cm.OnStateChange = func(c *call.CallInfo) {
		if c.IsEnded() {
			e.teardownCall(callID, string(c.StateData.EndReason))
			return
		}
		status := mapVoipStatus(c.StateData.State)
		ac.status = status
		rec := core.CallRecord{
			CallID:    callID,
			SessionID: ac.sessionID,
			TenantID:  ac.tenantID,
			Direction: ac.direction,
			Peer:      c.PeerJid,
			Owner:     ac.owner,
			StartedAt: ac.startedAt,
			Status:    status,
		}
		_ = e.store.UpsertCall(context.Background(), rec)
		e.broker.Publish(core.NewEvent(core.EventCallStatus, ac.sessionID, callID, ac.tenantID, map[string]any{
			"id":        callID,
			"callId":    callID,
			"owner":     ac.owner,
			"status":    status,
			"peer":      c.PeerJid,
			"startedAt": ac.startedAt,
			"call":      rec,
		}))
		e.broker.Publish(core.NewEvent(core.EventCallList, "", "", ac.tenantID, map[string]any{
			"calls": e.ListCalls(ac.tenantID, ""),
		}))
	}

	cm.OnEnded = func(c *call.CallInfo) {
		e.teardownCall(callID, string(c.StateData.EndReason))
	}

	cm.OnPeerAudio = func(pcm16 []float32) {
		e.mu.RLock()
		callRef, ok := e.activeCalls[callID]
		var br *webrtc.Bridge
		var wsBr *webrtc.WSBridge
		if ok {
			br = callRef.bridge
			wsBr = callRef.wsBridge
		}
		e.mu.RUnlock()

		if wsBr != nil {
			_ = wsBr.WritePCM(pcm16)
		} else if br != nil {
			_ = br.WritePCM(pcm16)
		}
	}
}

func (e *Engine) teardownCall(callID, reason string) {
	e.mu.Lock()
	ac, ok := e.activeCalls[callID]
	if ok {
		delete(e.activeCalls, callID)
	}
	e.mu.Unlock()

	if !ok {
		return
	}

	if ac.wsBridge != nil {
		ac.wsBridge.Close()
	}
	if ac.bridge != nil {
		ac.bridge.Close()
	}

	now := time.Now().UnixMilli()
	duration := now - ac.startedAt
	rec := core.CallRecord{
		CallID:     callID,
		SessionID:  ac.sessionID,
		TenantID:   ac.tenantID,
		Direction:  ac.direction,
		Peer:       ac.peer,
		Owner:      ac.owner,
		StartedAt:  ac.startedAt,
		EndedAt:    now,
		DurationMs: duration,
		Status:     "ended",
		EndReason:  reason,
	}
	_ = e.store.UpsertCall(context.Background(), rec)
	e.broker.Publish(core.NewEvent(core.EventCallEnded, ac.sessionID, callID, ac.tenantID, map[string]any{
		"id":         callID,
		"callId":     callID,
		"owner":      ac.owner,
		"reason":     reason,
		"end_reason": reason,
		"endedAt":    now,
		"duration":   duration,
	}))
	e.broker.Publish(core.NewEvent(core.EventCallList, "", "", ac.tenantID, map[string]any{
		"calls": e.ListCalls(ac.tenantID, ""),
	}))
}

// StartCall initiates an outgoing WhatsApp call.
func (e *Engine) StartCall(ctx context.Context, tenantID, sessionID string, req core.CallRequest, clientID string) (string, error) {
	provider, ok := e.providers.Get(tenantID, sessionID)
	if !ok {
		return "", core.ErrNotFound
	}

	caps := provider.GetCapabilities()
	if !caps.SupportsVoIPSignaling {
		return "", core.ErrVoipUnsupported
	}

	status, err := provider.GetSessionStatus(ctx)
	if err != nil || !status.CanCall {
		return "", core.ErrSessionNotPaired
	}

	e.mu.RLock()
	// Check operator busy state
	for _, ac := range e.activeCalls {
		if ac.owner != nil && *ac.owner == clientID {
			e.mu.RUnlock()
			return "", core.ErrOperatorBusy
		}
	}
	// Check max concurrent calls
	if e.maxCalls > 0 && len(e.activeCalls) >= e.maxCalls {
		e.mu.RUnlock()
		return "", core.ErrMaxConcurrentCalls
	}
	e.mu.RUnlock()

	sock, err := provider.GetVoipSocket()
	if err != nil {
		return "", err
	}

	phone := normalizePhone(req.Phone)
	if phone == "" {
		return "", fmt.Errorf("phone number required")
	}
	peer := types.NewJID(phone, types.DefaultUserServer)

	callID := signaling.GenerateCallID()
	cm := call.NewCallManager(sock, e.log)

	ownerVal := clientID
	ac := &activeCall{
		callID:    callID,
		sessionID: sessionID,
		tenantID:  tenantID,
		peer:      peer.String(),
		direction: "outbound",
		startedAt: time.Now().UnixMilli(),
		status:    "ringing",
		owner:     &ownerVal,
		cm:        cm,
	}

	e.mu.Lock()
	e.activeCalls[callID] = ac
	e.mu.Unlock()

	e.wireCallManager(ac)

	if err := cm.StartCall(ctx, callID, peer, req.IsVideo); err != nil {
		e.mu.Lock()
		delete(e.activeCalls, callID)
		e.mu.Unlock()
		return "", err
	}

	rec := core.CallRecord{
		CallID:    callID,
		SessionID: sessionID,
		TenantID:  tenantID,
		Direction: "outbound",
		Peer:      peer.String(),
		Owner:     &ownerVal,
		StartedAt: ac.startedAt,
		Status:    "ringing",
	}
	_ = e.store.UpsertCall(ctx, rec)
	e.broker.Publish(core.NewEvent(core.EventCallStatus, sessionID, callID, tenantID, map[string]any{
		"id":        callID,
		"callId":    callID,
		"owner":     &ownerVal,
		"status":    "ringing",
		"peer":      peer.String(),
		"startedAt": ac.startedAt,
		"call":      rec,
	}))
	e.broker.Publish(core.NewEvent(core.EventCallList, "", "", tenantID, map[string]any{
		"calls": e.ListCalls(tenantID, ""),
	}))

	return callID, nil
}

func matchesTenant(reqTenant, callTenant string) bool {
	if reqTenant == "" || reqTenant == "default" {
		return callTenant == "" || callTenant == "default"
	}
	return reqTenant == callTenant
}

// AcceptCall accepts an inbound ringing call.
func (e *Engine) AcceptCall(ctx context.Context, tenantID, sessionID, callID string, clientID string) error {
	e.mu.Lock()
	ac, ok := e.activeCalls[callID]
	if !ok || !matchesTenant(tenantID, ac.tenantID) {
		e.mu.Unlock()
		return core.ErrCallNotFound
	}
	// Check if already claimed by someone else
	if ac.owner != nil && *ac.owner != "" && *ac.owner != clientID {
		e.mu.Unlock()
		return core.ErrCallClaimed
	}
	// Check if this operator is already active elsewhere
	for cid, other := range e.activeCalls {
		if cid != callID && other.owner != nil && *other.owner == clientID {
			e.mu.Unlock()
			return core.ErrOperatorBusy
		}
	}
	ac.owner = &clientID
	e.mu.Unlock()

	e.broker.Publish(core.NewEvent(core.EventIncomingClaimed, sessionID, callID, tenantID, map[string]any{
		"id":      callID,
		"callId":  callID,
		"call_id": callID,
		"owner":   clientID,
	}))

	return ac.cm.AcceptCall(ctx, callID)
}

// RejectCall rejects an inbound call.
func (e *Engine) RejectCall(ctx context.Context, tenantID, sessionID, callID string) error {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if !ok || !matchesTenant(tenantID, ac.tenantID) {
		return core.ErrCallNotFound
	}

	_ = ac.cm.RejectCall(ctx, callID, voipCore.EndCallReasonDeclined)
	e.teardownCall(callID, string(voipCore.EndCallReasonDeclined))
	return nil
}

// EndCall terminates an ongoing call.
func (e *Engine) EndCall(ctx context.Context, tenantID, sessionID, callID string) error {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if !ok || !matchesTenant(tenantID, ac.tenantID) {
		return core.ErrCallNotFound
	}

	_ = ac.cm.EndCall(ctx, voipCore.EndCallReasonUserEnded)
	e.teardownCall(callID, string(voipCore.EndCallReasonUserEnded))
	return nil
}

// HandleWebRTC creates a WebRTC DataChannel bridge for browser audio.
func (e *Engine) HandleWebRTC(ctx context.Context, tenantID, sessionID, callID string, sdpOffer string) (string, error) {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if !ok || !matchesTenant(tenantID, ac.tenantID) {
		return "", core.ErrCallNotFound
	}

	bridge, answer, err := webrtc.NewBridge(sdpOffer, e.stunServers, e.log)
	if err != nil {
		return "", err
	}

	bridge.OnBrowserPCM = func(pcm []float32) {
		e.mu.RLock()
		hasWS := ac.wsBridge != nil
		e.mu.RUnlock()
		if !hasWS {
			ac.cm.FeedCapturedPCM(pcm)
		}
	}
	bridge.OnTerminalICE = func() {
		go func() {
			_ = e.EndCall(context.Background(), tenantID, sessionID, callID)
		}()
	}

	e.mu.Lock()
	if ac.bridge != nil {
		ac.bridge.Close()
	}
	ac.bridge = bridge
	e.mu.Unlock()

	return answer, nil
}

// AttachSocketBridge registers a WebSocket audio bridge for the call.
func (e *Engine) AttachSocketBridge(ctx context.Context, tenantID, sessionID, callID string, wsBridge *webrtc.WSBridge) error {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if !ok || !matchesTenant(tenantID, ac.tenantID) {
		return core.ErrCallNotFound
	}

	e.mu.Lock()
	if ac.wsBridge != nil && ac.wsBridge != wsBridge {
		ac.wsBridge.Close()
	}
	ac.wsBridge = wsBridge
	e.mu.Unlock()
	return nil
}

// FeedCallPCM passes browser PCM into the active call's CallManager.
func (e *Engine) FeedCallPCM(callID string, pcm []float32) {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	e.mu.RUnlock()
	if ok && ac.cm != nil {
		ac.cm.FeedCapturedPCM(pcm)
	}
}

// DetachBridge removes the WebSocket bridge reference when the socket closes.
func (e *Engine) DetachBridge(callID string, wsBridge *webrtc.WSBridge) {
	e.mu.Lock()
	if ac, ok := e.activeCalls[callID]; ok && ac.wsBridge == wsBridge {
		ac.wsBridge = nil
	}
	e.mu.Unlock()
}

func (e *Engine) GetCall(tenantID, callID string) (*core.CallRecord, bool) {
	e.mu.RLock()
	ac, ok := e.activeCalls[callID]
	if ok && matchesTenant(tenantID, ac.tenantID) {
		rec := core.CallRecord{
			CallID:    ac.callID,
			SessionID: ac.sessionID,
			TenantID:  ac.tenantID,
			Direction: ac.direction,
			Peer:      ac.peer,
			Owner:     ac.owner,
			StartedAt: ac.startedAt,
			Status:    mapVoipStatus(ac.cm.CurrentCall().StateData.State),
		}
		e.mu.RUnlock()
		return &rec, true
	}
	e.mu.RUnlock()

	rec, err := e.store.GetCall(context.Background(), tenantID, callID)
	if err == nil {
		return rec, true
	}
	return nil, false
}

func (e *Engine) ListCalls(tenantID, sessionID string) []core.CallRecord {
	e.mu.RLock()
	defer e.mu.RUnlock()

	out := make([]core.CallRecord, 0)
	for _, ac := range e.activeCalls {
		if ac.tenantID == tenantID && (sessionID == "" || ac.sessionID == sessionID) {
			status := ac.status
			if status == "" {
				status = "ringing"
			}
			out = append(out, core.CallRecord{
				CallID:    ac.callID,
				SessionID: ac.sessionID,
				TenantID:  ac.tenantID,
				Direction: ac.direction,
				Peer:      ac.peer,
				Owner:     ac.owner,
				StartedAt: ac.startedAt,
				Status:    status,
			})
		}
	}
	return out
}

func (e *Engine) History(tenantID, sessionID string, limit int) []core.CallRecord {
	rows, err := e.store.History(context.Background(), tenantID, sessionID, limit)
	if err != nil {
		return nil
	}
	return rows
}

func (e *Engine) ActiveCallCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.activeCalls)
}

func (e *Engine) TeardownAll() {
	e.mu.Lock()
	calls := make([]*activeCall, 0, len(e.activeCalls))
	for _, ac := range e.activeCalls {
		calls = append(calls, ac)
	}
	e.activeCalls = make(map[string]*activeCall)
	e.mu.Unlock()

	for _, ac := range calls {
		_ = ac.cm.EndCall(context.Background(), voipCore.EndCallReasonUserEnded)
		if ac.bridge != nil {
			ac.bridge.Close()
		}
	}
}

func mapVoipStatus(state voipCore.CallState) string {
	switch state {
	case voipCore.CallStateActive:
		return "connected"
	case voipCore.CallStateEnded:
		return "ended"
	case voipCore.CallStateInitiating:
		return "starting"
	default:
		return "ringing"
	}
}

func callIDFromNode(node *waBinary.Node) string {
	if node == nil {
		return ""
	}
	for _, child := range wanode.NodeChildren(node) {
		if id := wanode.AttrString(child.Attrs, "call-id"); id != "" {
			return id
		}
	}
	return wanode.AttrString(node.Attrs, "call-id")
}

func normalizePhone(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "+")
	var b strings.Builder
	for _, c := range p {
		if c >= '0' && c <= '9' {
			b.WriteRune(c)
		}
	}
	return b.String()
}


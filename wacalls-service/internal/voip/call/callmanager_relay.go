package call

import (
	"wacalls/internal/voip/core"
	"wacalls/internal/voip/transport"
)

type RelayTransport interface {
	SetSsrc(ssrc uint32)
	SetSubscriptionSsrc(ssrc uint32)
	SetOnConnected(fn func(ip string, port int))
	SetOnReceive(fn func(data []byte))
	ResendSubscriptions()
	ConfigureRelays(relays []transport.RelayConfig)
	Broadcast(data []byte)
	HasConnection() bool
	ConnectedCount() int
	Cleanup()
}

var _ RelayTransport = (*transport.SctpRelayManager)(nil)

func (m *CallManager) onRelayConnected() {
	m.mu.Lock()
	call := m.currentCall
	if call == nil {
		m.mu.Unlock()
		return
	}

	state := call.StateData.State
	m.log.Info("[CALL] Relay datachannel open", "call_id", call.CallID, "call_state", string(state))

	switch state {
	case core.CallStateMediaConnecting, core.CallStateRemoteAccepted:
		// Remote has already accepted; relay just connected → go active immediately.
		if err := call.ApplyTransition(Transition{Type: TransitionMediaConnected}); err == nil {
			m.emitState()
			m.startSilenceKeepaliveLocked()
			m.log.Info("[CALL] Relay connected → ACTIVE", "call_id", call.CallID)
		}

	case core.CallStateRemoteRinging, core.CallStateServerAcknowledged, core.CallStateOfferSent:
		// Relay connected while callee is still ringing. Store the flag so that
		// HandleCallAccept can transition to Active immediately without waiting
		// for a second relay connect.
		m.relayPreConnected = true
		m.log.Info("[CALL] Relay pre-connected (waiting for callee accept)", "call_id", call.CallID)

	default:
		m.log.Warn("[CALL] Relay connected in unexpected state (ignoring)", "call_id", call.CallID, "state", string(state))
	}
	m.mu.Unlock()
}

func buildRelayConfigs(endpoints []core.RelayEndpoint) []transport.RelayConfig {
	seen := map[string]bool{}
	var relays []transport.RelayConfig

	appendValid := func(allowNonUDP bool) {
		for _, ep := range endpoints {
			if !allowNonUDP && ep.Protocol != 0 {
				continue
			}
			if ep.Key == "" || ep.RawToken == nil {
				continue
			}
			key := ep.IP
			if seen[key] {
				continue
			}
			seen[key] = true
			name := ep.RelayName
			if name == "" {
				name = ep.IP
			}
			port := ep.Port
			if port == 0 {
				port = core.WARelayPort
			}
			if port == 0 {
				port = 3478
			}
			relays = append(relays, transport.RelayConfig{
				IP: ep.IP, Port: port, Token: ep.Token, AuthToken: ep.AuthToken,
				RawAuthToken: ep.RawAuthToken, RawToken: ep.RawToken, Key: ep.Key,
				RelayID: ep.RelayID, Name: name, AuthTokenID: ep.AuthTokenID,
			})
		}
	}

	// First attempt: preferred UDP endpoints (protocol == 0)
	appendValid(false)
	// If no UDP endpoints found, fall back to any available endpoints
	if len(relays) == 0 {
		appendValid(true)
	}

	return relays
}

func (m *CallManager) connectRelays(endpoints []core.RelayEndpoint) {
	relays := buildRelayConfigs(endpoints)
	if len(relays) == 0 {
		m.log.Error("[CALL] no usable relay configs from endpoints", "total_endpoints", len(endpoints))
		return
	}
	m.mu.Lock()
	m.relay.SetSsrc(m.selfSsrc)
	m.relay.SetSubscriptionSsrc(firstSsrc(m.peerSsrcs))
	m.mu.Unlock()
	m.log.Info("[CALL] configuring media relays", "count", len(relays), "self_ssrc", m.selfSsrc, "sub_ssrc", firstSsrc(m.peerSsrcs))
	m.relay.ConfigureRelays(relays)
	m.log.Info("[CALL] relay configured", "connected", m.relay.ConnectedCount())
}

func (m *CallManager) cleanupMedia() {
	m.mu.Lock()
	codec := m.codec
	m.codec = nil
	if m.keepaliveStop != nil {
		close(m.keepaliveStop)
		m.keepaliveStop = nil
	}
	m.rtpSession = nil
	m.srtpSession = nil
	m.firstPacketSent = false
	m.initialTransportSent = false
	m.outgoingPreacceptSent = false
	m.actualPeerSet = false
	m.relayPreConnected = false
	m.encodeBuf = nil
	m.encodeBufPos = 0
	m.preBuffer = nil
	m.inAudioPackets = 0
	m.outAudioPackets = 0
	m.bidiLogged = false
	m.mu.Unlock()

	m.relay.Cleanup()
	if codec != nil {
		codec.Close()
	}
}

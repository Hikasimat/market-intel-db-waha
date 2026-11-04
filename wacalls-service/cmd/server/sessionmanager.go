package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"

	"go.mau.fi/whatsmeow/types"
)

// BridgeRegistration is sent by the Node host whenever a Baileys session connects.
type BridgeRegistration struct {
	Name           string `json:"name"`
	JID            string `json:"jid"`
	LID            string `json:"lid"`
	DeviceIdentity []byte `json:"deviceIdentity"` // base64 in JSON
}

type SessionManager struct {
	appCtx   context.Context
	broker   *Broker
	log      *slog.Logger
	maxCalls int
	rpc      *rpcClient

	mu       sync.RWMutex
	sessions map[string]*Session
	order    []string
}

func newSessionManager(ctx context.Context, broker *Broker, log *slog.Logger, maxCalls int, rpc *rpcClient) *SessionManager {
	return &SessionManager{
		appCtx:   ctx,
		broker:   broker,
		log:      log,
		maxCalls: maxCalls,
		rpc:      rpc,
		sessions: map[string]*Session{},
	}
}

// sessionIDFor derives a stable session id from the session name so ids survive restarts.
func sessionIDFor(name string) string {
	sum := sha1.Sum([]byte("wacalls-bridge:" + name))
	return hex.EncodeToString(sum[:16])
}

func (m *SessionManager) register(s *Session) {
	m.mu.Lock()
	m.sessions[s.id] = s
	m.order = append(m.order, s.id)
	m.mu.Unlock()
}

func (m *SessionManager) unregister(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	for i, x := range m.order {
		if x == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
}

func (m *SessionManager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	return s, ok
}

func (m *SessionManager) infos() []SessionInfo {
	m.mu.RLock()
	ordered := make([]*Session, 0, len(m.order))
	for _, id := range m.order {
		if s, ok := m.sessions[id]; ok {
			ordered = append(ordered, s)
		}
	}
	m.mu.RUnlock()
	out := make([]SessionInfo, 0, len(ordered))
	for _, s := range ordered {
		out = append(out, s.info())
	}
	return out
}

func (m *SessionManager) snapshotEvents() []any {
	return []any{map[string]any{"type": "session-list", "sessions": m.infos()}}
}

// Upsert registers (or refreshes after a Baileys reconnect) a bridged session.
func (m *SessionManager) Upsert(reg BridgeRegistration) (*Session, error) {
	if reg.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	ownPN, err := types.ParseJID(reg.JID)
	if err != nil {
		return nil, fmt.Errorf("invalid jid %q: %w", reg.JID, err)
	}
	// Call creator must be a non-AD user JID (no :device component)
	ownPN = ownPN.ToNonAD()
	var ownLID types.JID
	if reg.LID != "" {
		if lid, err := types.ParseJID(reg.LID); err == nil {
			ownLID = lid.ToNonAD()
		}
	}
	sock := &bridgeSocket{
		name:        reg.Name,
		ownPN:       ownPN,
		ownLID:      ownLID,
		devIdentity: reg.DeviceIdentity,
		rpc:         m.rpc,
	}
	id := sessionIDFor(reg.Name)
	if existing, ok := m.Get(id); ok {
		existing.update(sock, ownPN.String())
		m.log.Info("bridged session refreshed", "session", id, "name", reg.Name, "jid", ownPN.String())
		return existing, nil
	}
	s := newSession(m, id, reg.Name, sock, ownPN.String())
	m.register(s)
	m.broker.emitSessionList(m.infos())
	m.log.Info("bridged session registered", "session", id, "name", reg.Name, "jid", ownPN.String())
	return s, nil
}

// Disconnect marks a bridged session closed (Baileys connection dropped / logged out).
func (m *SessionManager) Disconnect(name string) {
	if s, ok := m.Get(sessionIDFor(name)); ok {
		s.disconnect()
		m.log.Info("bridged session disconnected", "session", s.id, "name", name)
	}
}

func (m *SessionManager) disconnectAll() {
	m.mu.RLock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.RUnlock()
	for _, s := range all {
		s.shutdown()
	}
}

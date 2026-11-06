package core

import (
	"encoding/json"
	"time"
)

// EventType enumerates system and call event categories.
type EventType string

const (
	EventSessionList     EventType = "session-list"
	EventSessionQR       EventType = "session-qr"
	EventAuthState       EventType = "auth-state"
	EventCallIncoming    EventType = "incoming"
	EventCallStatus      EventType = "call-status"
	EventCallEnded       EventType = "call-ended"
	EventCallList        EventType = "call-list"
	EventIncomingClaimed EventType = "incoming-claimed"
	EventMediaConnected  EventType = "media-connected"
	EventError           EventType = "error"
)

// Event is the envelope for SSE and webhook event notifications.
type Event struct {
	ID        string         `json:"id,omitempty"`
	Type      EventType      `json:"type"`
	TenantID  string         `json:"tenant_id,omitempty"`
	SessionID string         `json:"session_id,omitempty"`
	CallID    string         `json:"call_id,omitempty"`
	Timestamp int64          `json:"timestamp"`
	Payload   map[string]any `json:"payload"`
}

// MarshalJSON flattens payload fields to the top level for browser SSE compatibility
// while preserving snake_case fields for backend and SDK consumers.
func (e Event) MarshalJSON() ([]byte, error) {
	m := make(map[string]any, len(e.Payload)+10)
	for k, v := range e.Payload {
		m[k] = v
	}
	m["type"] = e.Type
	if e.SessionID != "" {
		m["sessionId"] = e.SessionID
		m["session_id"] = e.SessionID
	}
	if e.CallID != "" {
		m["callId"] = e.CallID
		m["call_id"] = e.CallID
		if _, exists := m["id"]; !exists {
			m["id"] = e.CallID
		}
	}
	if e.TenantID != "" {
		m["tenant_id"] = e.TenantID
	}
	if e.ID != "" {
		m["id"] = e.ID
	}
	if e.Timestamp > 0 {
		m["timestamp"] = e.Timestamp
	}
	return json.Marshal(m)
}

// NewEvent helper constructor
func NewEvent(eventType EventType, sessionID, callID, tenantID string, payload map[string]any) Event {
	return Event{
		Type:      eventType,
		TenantID:  tenantID,
		SessionID: sessionID,
		CallID:    callID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   payload,
	}
}


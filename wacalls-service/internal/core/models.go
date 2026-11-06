package core

import (
	"encoding/json"
	"time"
)

// ProviderCapabilities describes the operational capabilities of a WhatsApp provider.
type ProviderCapabilities struct {
	HasNativeAuth               bool   `json:"has_native_auth"`
	HasExternalQROwner          bool   `json:"has_external_qr_owner"`
	SupportsSessionReuse        bool   `json:"supports_session_reuse"`
	SupportsVoIPSignaling       bool   `json:"supports_voip_signaling"`
	SupportsIncomingCalls       bool   `json:"supports_incoming_calls"`
	SupportsOutgoingCalls       bool   `json:"supports_outgoing_calls"`
	SupportsCallAcceptance      bool   `json:"supports_call_acceptance"`
	SupportsCallRejection       bool   `json:"supports_call_rejection"`
	SupportsCallTermination     bool   `json:"supports_call_termination"`
	SupportsBidirectionalAudio  bool   `json:"supports_bidirectional_audio"`
	SupportsCallEvents          bool   `json:"supports_call_events"`
	SupportsConcurrentCalls     bool   `json:"supports_concurrent_calls"`
	MaxConcurrentCalls          int    `json:"max_concurrent_calls"`
	UnsupportedReason           string `json:"unsupported_reason,omitempty"`
}

// SessionStatus reports the live state of a WhatsApp session.
type SessionStatus struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	TenantID  string `json:"tenant_id,omitempty"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	State     string `json:"state"` // "init", "connecting", "qr", "open", "logged_out", "failed"
	Paired    bool   `json:"paired"`
	JID       string `json:"jid,omitempty"`
	Phone     string `json:"phone,omitempty"`
	CanCall   bool   `json:"can_call"`
	Reason    string `json:"reason,omitempty"`
	UpdatedAt int64  `json:"updated_at"`
}

// QRCode represents an authentication QR code or pairing code.
type QRCode struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expires_at"`
	Source    string    `json:"source"` // "native", "waha", "external"
}

// ProviderConfig represents stored provider settings for a tenant.
type ProviderConfig struct {
	ID        string         `json:"id"`
	TenantID  string         `json:"tenant_id"`
	Type      string         `json:"type"` // "native", "waha", "custom"
	Name      string         `json:"name"`
	Settings  map[string]any `json:"settings,omitempty"`
	IsDefault bool           `json:"is_default"`
	CreatedAt int64          `json:"created_at"`
	UpdatedAt int64          `json:"updated_at"`
}

// CallRecord captures historical and active call metadata.
type CallRecord struct {
	CallID     string  `json:"callId"`
	SessionID  string  `json:"sessionId"`
	TenantID   string  `json:"tenantId,omitempty"`
	Direction  string  `json:"direction"` // "inbound", "outbound"
	Peer       string  `json:"peer"`
	Owner      *string `json:"owner,omitempty"`
	StartedAt  int64   `json:"startedAt"`
	EndedAt    int64   `json:"endedAt,omitempty"`
	DurationMs int64   `json:"durationMs,omitempty"`
	Status     string  `json:"status"` // "starting", "ringing", "connected", "ended"
	EndReason  string  `json:"endReason,omitempty"`
}

func (c CallRecord) MarshalJSON() ([]byte, error) {
	type Alias CallRecord
	return json.Marshal(&struct {
		Alias
		SnakeCallID    string `json:"call_id"`
		SnakeSessionID string `json:"session_id"`
		SnakeTenantID  string `json:"tenant_id,omitempty"`
		SnakeStartedAt int64  `json:"started_at"`
		SnakeEndedAt   int64  `json:"ended_at,omitempty"`
		SnakeDuration  int64  `json:"duration_ms,omitempty"`
		SnakeEndReason string `json:"end_reason,omitempty"`
	}{
		Alias:          Alias(c),
		SnakeCallID:    c.CallID,
		SnakeSessionID: c.SessionID,
		SnakeTenantID:  c.TenantID,
		SnakeStartedAt: c.StartedAt,
		SnakeEndedAt:   c.EndedAt,
		SnakeDuration:  c.DurationMs,
		SnakeEndReason: c.EndReason,
	})
}

// CallRequest is the payload for starting an outbound call.
type CallRequest struct {
	Phone      string `json:"phone"`
	IsVideo    bool   `json:"is_video,omitempty"`
	DurationMs int    `json:"duration_ms,omitempty"`
	Record     bool   `json:"record,omitempty"`
}


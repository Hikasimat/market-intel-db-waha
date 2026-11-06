package core

import (
	"context"
	voipCore "wacalls/internal/voip/core"
)

// WhatsAppProvider represents Layer A: A pluggable WhatsApp session provider.
type WhatsAppProvider interface {
	ID() string
	TenantID() string
	Type() string
	Name() string
	GetCapabilities() ProviderCapabilities

	Connect(ctx context.Context) error
	Disconnect(ctx context.Context) error

	GetSessionStatus(ctx context.Context) (SessionStatus, error)
	GetQRCode(ctx context.Context) (QRCode, error)
	Pair(ctx context.Context) error
	Logout(ctx context.Context) error

	// GetVoipSocket returns the low-level VoipSocket if supported, or ErrVoipUnsupported.
	GetVoipSocket() (voipCore.VoipSocket, error)

	SubscribeEvents(ctx context.Context) (<-chan Event, error)
	Close() error
}

// CallingEngine represents Layer B: The universal calling coordinator.
type CallingEngine interface {
	StartCall(ctx context.Context, tenantID, sessionID string, req CallRequest, clientID string) (string, error)
	AcceptCall(ctx context.Context, tenantID, sessionID, callID string, clientID string) error
	RejectCall(ctx context.Context, tenantID, sessionID, callID string) error
	EndCall(ctx context.Context, tenantID, sessionID, callID string) error
	HandleWebRTC(ctx context.Context, tenantID, sessionID, callID string, sdpOffer string) (string, error)
	GetCall(tenantID, callID string) (*CallRecord, bool)
	ListCalls(tenantID, sessionID string) []CallRecord
	History(tenantID, sessionID string, limit int) []CallRecord
}

// EventBroker distributes real-time events to connected HTTP clients (SSE) or webhooks.
type EventBroker interface {
	Publish(evt Event)
	Subscribe(tenantID string, clientID string) (<-chan Event, func())
}


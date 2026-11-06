package session

import (
	"context"
	"log/slog"
	"testing"

	"wacalls/internal/core"
	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/providers/custom"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

// mockVoipSocket implements voipCore.VoipSocket for testing
type mockVoipSocket struct{}

func (m *mockVoipSocket) OwnPN() types.JID                                  { return types.NewJID("1111", "s.whatsapp.net") }
func (m *mockVoipSocket) OwnLID() types.JID                                 { return types.NewJID("1111", "lid") }
func (m *mockVoipSocket) AccountDeviceIdentityNode() (waBinary.Node, bool) { return waBinary.Node{}, false }
func (m *mockVoipSocket) SendNode(ctx context.Context, node waBinary.Node) error { return nil }
func (m *mockVoipSocket) Query(ctx context.Context, node waBinary.Node) (*waBinary.Node, error) {
	return &waBinary.Node{Tag: "ack"}, nil
}
func (m *mockVoipSocket) GetUSyncDevices(ctx context.Context, jids []types.JID) ([]types.JID, error) {
	return jids, nil
}
func (m *mockVoipSocket) AssertSessions(ctx context.Context, jids []types.JID, force bool) error {
	return nil
}
func (m *mockVoipSocket) CreateParticipantNodes(ctx context.Context, devices []types.JID, callKey []byte, encAttrs waBinary.Attrs) ([]waBinary.Node, bool, error) {
	return []waBinary.Node{{Tag: "enc"}}, false, nil
}
func (m *mockVoipSocket) DecryptCallKey(ctx context.Context, from types.JID, encChild *waBinary.Node) ([]byte, error) {
	return make([]byte, 32), nil
}
func (m *mockVoipSocket) GetTCToken(ctx context.Context, jid types.JID) ([]byte, error) {
	return nil, nil
}
func (m *mockVoipSocket) ResolveLIDForPN(ctx context.Context, pn types.JID) types.JID {
	return pn
}

func TestEngineRejectsUnsupportedProviderVoip(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	store, _ := NewStore(ctx, db)
	reg := providers.NewRegistry(nil, slog.Default(), nil)
	broker := events.NewBroker()
	engine := NewEngine(reg, store, broker, 5, nil, slog.Default())

	// Create a provider without VoIP capability
	unsupportedProv := custom.NewCustomProvider(custom.Config{
		ID:       "waha-unsupported",
		TenantID: "tenant-1",
		Name:     "WAHA WebJS",
		Capabilities: core.ProviderCapabilities{
			SupportsVoIPSignaling: false,
			UnsupportedReason:     "WAHA WEBJS does not support calling",
		},
	})
	reg.Register(unsupportedProv)

	// Attempt to start call
	_, err := engine.StartCall(ctx, "tenant-1", "waha-unsupported", core.CallRequest{Phone: "+1234567890"}, "op-1")
	if err != core.ErrVoipUnsupported {
		t.Fatalf("expected ErrVoipUnsupported, got: %v", err)
	}
}

func TestEngineConcurrentCallLimit(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	store, _ := NewStore(ctx, db)
	reg := providers.NewRegistry(nil, slog.Default(), nil)
	broker := events.NewBroker()
	// Max 1 call
	engine := NewEngine(reg, store, broker, 1, nil, slog.Default())

	prov := custom.NewCustomProvider(custom.Config{
		ID:       "prov-calling",
		TenantID: "tenant-1",
		Name:     "Custom Calling",
		Capabilities: core.ProviderCapabilities{
			SupportsVoIPSignaling: true,
		},
		MockSocket: &mockVoipSocket{},
	})
	prov.SetState("open", "1111@s.whatsapp.net")
	reg.Register(prov)

	call1, err := engine.StartCall(ctx, "tenant-1", "prov-calling", core.CallRequest{Phone: "+1234567890"}, "op-1")
	if err != nil {
		t.Fatalf("start call 1 failed: %v", err)
	}
	if call1 == "" {
		t.Fatal("empty callID returned")
	}

	// Second call should exceed capacity
	_, err = engine.StartCall(ctx, "tenant-1", "prov-calling", core.CallRequest{Phone: "+9876543210"}, "op-2")
	if err != core.ErrMaxConcurrentCalls {
		t.Fatalf("expected ErrMaxConcurrentCalls, got: %v", err)
	}
}

func TestEngineOperatorBusyConflict(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	store, _ := NewStore(ctx, db)
	reg := providers.NewRegistry(nil, slog.Default(), nil)
	broker := events.NewBroker()
	engine := NewEngine(reg, store, broker, 5, nil, slog.Default())

	prov := custom.NewCustomProvider(custom.Config{
		ID:       "prov-calling",
		TenantID: "tenant-1",
		Name:     "Custom Calling",
		Capabilities: core.ProviderCapabilities{
			SupportsVoIPSignaling: true,
		},
		MockSocket: &mockVoipSocket{},
	})
	prov.SetState("open", "1111@s.whatsapp.net")
	reg.Register(prov)

	_, err := engine.StartCall(ctx, "tenant-1", "prov-calling", core.CallRequest{Phone: "+1234567890"}, "op-1")
	if err != nil {
		t.Fatalf("start call 1 failed: %v", err)
	}

	// Same operator op-1 attempting another call
	_, err = engine.StartCall(ctx, "tenant-1", "prov-calling", core.CallRequest{Phone: "+9876543210"}, "op-1")
	if err != core.ErrOperatorBusy {
		t.Fatalf("expected ErrOperatorBusy, got: %v", err)
	}
}

package custom

import (
	"context"
	"fmt"
	"sync"
	"time"

	"wacalls/internal/core"
	voipCore "wacalls/internal/voip/core"
)

// Config defines options for CustomProvider
type Config struct {
	ID           string
	TenantID     string
	Name         string
	Capabilities core.ProviderCapabilities
	MockSocket   voipCore.VoipSocket
}

// CustomProvider provides a mockable or custom WhatsApp session provider.
type CustomProvider struct {
	cfg      Config
	mu       sync.RWMutex
	state    string
	lastQR   string
	qrExpire time.Time
	jid      string
	subs     []chan core.Event
	subMu    sync.Mutex
}

// NewCustomProvider constructs a new CustomProvider
func NewCustomProvider(cfg Config) *CustomProvider {
	if cfg.TenantID == "" {
		cfg.TenantID = "default"
	}
	return &CustomProvider{
		cfg:      cfg,
		state:    "init",
		lastQR:   "mock-qr-code-" + cfg.ID,
		qrExpire: time.Now().Add(60 * time.Second),
	}
}

func (p *CustomProvider) ID() string       { return p.cfg.ID }
func (p *CustomProvider) TenantID() string { return p.cfg.TenantID }
func (p *CustomProvider) Type() string     { return "custom" }
func (p *CustomProvider) Name() string     { return p.cfg.Name }

func (p *CustomProvider) GetCapabilities() core.ProviderCapabilities {
	return p.cfg.Capabilities
}

func (p *CustomProvider) Connect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "open"
	p.jid = "1234567890@s.whatsapp.net"
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "open", "paired": true, "jid": p.jid})
	return nil
}

func (p *CustomProvider) Disconnect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "logged_out"
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *CustomProvider) GetSessionStatus(ctx context.Context) (core.SessionStatus, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	caps := p.GetCapabilities()
	canCall := (p.state == "open") && caps.SupportsVoIPSignaling

	return core.SessionStatus{
		ID:        p.cfg.ID,
		SessionID: p.cfg.ID,
		TenantID:  p.cfg.TenantID,
		Name:      p.cfg.Name,
		Provider:  "custom",
		State:     p.state,
		Paired:    p.state == "open",
		JID:       p.jid,
		CanCall:   canCall,
		Reason:    caps.UnsupportedReason,
		UpdatedAt: time.Now().UnixMilli(),
	}, nil
}

func (p *CustomProvider) GetQRCode(ctx context.Context) (core.QRCode, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.state == "open" {
		return core.QRCode{}, fmt.Errorf("session already paired")
	}
	return core.QRCode{
		Code:      p.lastQR,
		ExpiresAt: p.qrExpire,
		Source:    "custom",
	}, nil
}

func (p *CustomProvider) Pair(ctx context.Context) error {
	p.mu.Lock()
	p.state = "qr"
	p.lastQR = "custom-qr-" + time.Now().Format("150405")
	p.qrExpire = time.Now().Add(30 * time.Second)
	p.mu.Unlock()
	p.emitEvent(core.EventSessionQR, map[string]any{"qr": p.lastQR})
	return nil
}

func (p *CustomProvider) Logout(ctx context.Context) error {
	p.mu.Lock()
	p.state = "logged_out"
	p.jid = ""
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *CustomProvider) GetVoipSocket() (voipCore.VoipSocket, error) {
	if !p.cfg.Capabilities.SupportsVoIPSignaling {
		return nil, core.ErrVoipUnsupported
	}
	if p.cfg.MockSocket != nil {
		return p.cfg.MockSocket, nil
	}
	return nil, core.ErrVoipUnsupported
}

func (p *CustomProvider) SubscribeEvents(ctx context.Context) (<-chan core.Event, error) {
	ch := make(chan core.Event, 32)
	p.subMu.Lock()
	p.subs = append(p.subs, ch)
	p.subMu.Unlock()

	go func() {
		<-ctx.Done()
		p.subMu.Lock()
		for i, c := range p.subs {
			if c == ch {
				p.subs = append(p.subs[:i], p.subs[i+1:]...)
				close(ch)
				break
			}
		}
		p.subMu.Unlock()
	}()
	return ch, nil
}

func (p *CustomProvider) Close() error {
	p.subMu.Lock()
	for _, ch := range p.subs {
		close(ch)
	}
	p.subs = nil
	p.subMu.Unlock()
	return nil
}

func (p *CustomProvider) SetState(state string, jid string) {
	p.mu.Lock()
	p.state = state
	p.jid = jid
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": state, "paired": state == "open", "jid": jid})
}

func (p *CustomProvider) emitEvent(evtType core.EventType, payload map[string]any) {
	evt := core.NewEvent(evtType, p.cfg.ID, "", p.cfg.TenantID, payload)
	p.subMu.Lock()
	defer p.subMu.Unlock()
	for _, ch := range p.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}


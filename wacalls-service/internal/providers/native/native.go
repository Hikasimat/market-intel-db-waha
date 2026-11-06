package native

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"wacalls/internal/core"
	voipCore "wacalls/internal/voip/core"
	"wacalls/internal/voip/signaling"
	"wacalls/internal/voip/wanode"
	"wacalls/internal/wa"

	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func init() {
	if store.GetWAVersion().LessThan(store.WAVersionContainer{2, 3000, 1053393627}) {
		store.SetWAVersion(store.WAVersionContainer{2, 3000, 1053393627})
	}
}

// NativeProvider implements core.WhatsAppProvider using whatsmeow.
type NativeProvider struct {
	id        string
	tenantID  string
	name      string
	client    *whatsmeow.Client
	container *sqlstore.Container
	log       *slog.Logger
	waLogger  waLog.Logger

	mu        sync.RWMutex
	state     string // "connecting", "qr", "open", "logged_out"
	lastQR    string
	qrExpire  time.Time
	eventChan chan core.Event
	subs      []chan core.Event
	subMu     sync.Mutex

	// Callbacks for incoming VoIP call stanzas
	OnIncomingOffer     func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingAccept    func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingTransport func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingTerminate func(ctx context.Context, from types.JID, node *waBinary.Node)
}

// Config for native provider
type Config struct {
	ID        string
	TenantID  string
	Name      string
	Container *sqlstore.Container
	Device    *store.Device
	Log       *slog.Logger
	WALogger  waLog.Logger
}

// NewNativeProvider creates an instance of NativeProvider
func NewNativeProvider(cfg Config) *NativeProvider {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.WALogger == nil {
		cfg.WALogger = waLog.Noop
	}
	if cfg.TenantID == "" {
		cfg.TenantID = "default"
	}

	client := whatsmeow.NewClient(cfg.Device, cfg.WALogger)
	p := &NativeProvider{
		id:        cfg.ID,
		tenantID:  cfg.TenantID,
		name:      cfg.Name,
		client:    client,
		container: cfg.Container,
		log:       cfg.Log.With("provider", "native", "session", cfg.ID),
		waLogger:  cfg.WALogger,
		state:     "connecting",
		eventChan: make(chan core.Event, 64),
	}
	client.AddEventHandler(p.handleWhatsAppEvent)
	return p
}

func (p *NativeProvider) ID() string       { return p.id }
func (p *NativeProvider) TenantID() string { return p.tenantID }
func (p *NativeProvider) Type() string     { return "native" }
func (p *NativeProvider) Name() string     { return p.name }

func (p *NativeProvider) GetCapabilities() core.ProviderCapabilities {
	return core.ProviderCapabilities{
		HasNativeAuth:              true,
		HasExternalQROwner:         false,
		SupportsSessionReuse:       true,
		SupportsVoIPSignaling:      true,
		SupportsIncomingCalls:      true,
		SupportsOutgoingCalls:      true,
		SupportsCallAcceptance:     true,
		SupportsCallRejection:      true,
		SupportsCallTermination:    true,
		SupportsBidirectionalAudio: true,
		SupportsCallEvents:         true,
		SupportsConcurrentCalls:    true,
		MaxConcurrentCalls:         8,
	}
}

func (p *NativeProvider) Connect(ctx context.Context) error {
	p.mu.RLock()
	hasID := p.client.Store.ID != nil
	p.mu.RUnlock()

	if hasID {
		return p.client.Connect()
	}
	return p.startPairing(context.Background())
}

func (p *NativeProvider) Disconnect(ctx context.Context) error {
	p.client.Disconnect()
	p.mu.Lock()
	p.state = "logged_out"
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *NativeProvider) GetSessionStatus(ctx context.Context) (core.SessionStatus, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	jid := ""
	if p.client.Store.ID != nil {
		jid = p.client.Store.ID.String()
	}
	paired := p.client.Store.ID != nil

	return core.SessionStatus{
		ID:        p.id,
		SessionID: p.id,
		TenantID:  p.tenantID,
		Name:      p.name,
		Provider:  "native",
		State:     p.state,
		Paired:    paired,
		JID:       jid,
		Phone:     wanode.CleanJID(jid),
		CanCall:   paired && p.client.IsConnected(),
		UpdatedAt: time.Now().UnixMilli(),
	}, nil
}

func (p *NativeProvider) GetQRCode(ctx context.Context) (core.QRCode, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.client.Store.ID != nil {
		return core.QRCode{}, fmt.Errorf("session already paired")
	}
	if p.lastQR == "" {
		return core.QRCode{}, fmt.Errorf("no active QR code; start pairing first")
	}
	return core.QRCode{
		Code:      p.lastQR,
		ExpiresAt: p.qrExpire,
		Source:    "native",
	}, nil
}

func (p *NativeProvider) Pair(ctx context.Context) error {
	p.mu.RLock()
	alreadyPaired := p.client.Store.ID != nil
	p.mu.RUnlock()
	if alreadyPaired {
		return core.ErrSessionAlreadyPaired
	}
	p.client.Disconnect()
	newDev := p.container.NewDevice()
	newCli := whatsmeow.NewClient(newDev, p.waLogger)
	p.mu.Lock()
	p.client = newCli
	p.state = "connecting"
	p.mu.Unlock()
	newCli.AddEventHandler(p.handleWhatsAppEvent)
	return p.startPairing(context.Background())
}

func (p *NativeProvider) Logout(ctx context.Context) error {
	if p.client.Store.ID != nil {
		if err := p.client.Logout(ctx); err != nil {
			p.log.Warn("logout failed, unpairing locally", "err", err)
			_ = p.container.DeleteDevice(ctx, p.client.Store)
		}
	}
	p.client.Disconnect()
	newDev := p.container.NewDevice()
	newCli := whatsmeow.NewClient(newDev, p.waLogger)
	p.mu.Lock()
	p.client = newCli
	p.state = "logged_out"
	p.lastQR = ""
	p.mu.Unlock()
	newCli.AddEventHandler(p.handleWhatsAppEvent)
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *NativeProvider) Close() error {
	p.client.Disconnect()
	p.subMu.Lock()
	for _, ch := range p.subs {
		close(ch)
	}
	p.subs = nil
	p.subMu.Unlock()
	return nil
}

func (p *NativeProvider) GetVoipSocket() (voipCore.VoipSocket, error) {
	return wa.NewSocket(p.client), nil
}

func (p *NativeProvider) SubscribeEvents(ctx context.Context) (<-chan core.Event, error) {
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

func (p *NativeProvider) startPairing(_ context.Context) error {
	p.log.Info("requesting pairing QR channel from WhatsApp")
	qrChan, err := p.client.GetQRChannel(context.Background())
	if err != nil {
		p.log.Error("failed getting QR channel", "err", err)
		return err
	}
	p.log.Info("connecting client to WhatsApp network")
	if err := p.client.Connect(); err != nil {
		p.log.Error("failed connecting WhatsApp client", "err", err)
		return err
	}
	go func() {
		p.log.Info("waiting for pairing events from WhatsApp server...")
		for evt := range qrChan {
			p.log.Info("pairing event received", "event", evt.Event)
			switch evt.Event {
			case "code":
				p.log.Info("scan the QR code to pair this session", "code_len", len(evt.Code))
				qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				p.mu.Lock()
				p.state = "qr"
				p.lastQR = evt.Code
				p.qrExpire = time.Now().Add(20 * time.Second)
				p.mu.Unlock()
				p.emitEvent(core.EventSessionQR, map[string]any{"qr": evt.Code})
				p.emitEvent(core.EventAuthState, map[string]any{"state": "qr", "qr": evt.Code, "paired": false})
			case "success":
				p.mu.Lock()
				p.state = "open"
				p.lastQR = ""
				p.mu.Unlock()
				p.emitEvent(core.EventAuthState, map[string]any{"state": "open", "paired": true})
			case "timeout":
				p.mu.Lock()
				p.state = "logged_out"
				p.lastQR = ""
				p.mu.Unlock()
				p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
			}
		}
		p.log.Info("pairing event channel closed")
	}()
	return nil
}

func (p *NativeProvider) handleWhatsAppEvent(rawEvt any) {
	ctx := context.Background()
	switch evt := rawEvt.(type) {
	case *events.Connected:
		p.mu.Lock()
		p.state = "open"
		p.mu.Unlock()
		p.emitEvent(core.EventAuthState, map[string]any{"state": "open", "paired": true})
	case *events.LoggedOut:
		p.mu.Lock()
		p.state = "logged_out"
		p.lastQR = ""
		p.mu.Unlock()
		p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	case *events.CallOffer:
		node := wrapCall(evt.From, evt.Data)
		if p.OnIncomingOffer != nil {
			p.OnIncomingOffer(ctx, evt.From, node)
		}
	case *events.CallAccept:
		node := wrapCall(evt.From, evt.Data)
		if p.OnIncomingAccept != nil {
			p.OnIncomingAccept(ctx, evt.From, node)
		}
	case *events.CallTransport:
		node := wrapCall(evt.From, evt.Data)
		if p.OnIncomingTransport != nil {
			p.OnIncomingTransport(ctx, evt.From, node)
		}
	case *events.CallTerminate:
		node := wrapCall(evt.From, evt.Data)
		if p.OnIncomingTerminate != nil {
			p.OnIncomingTerminate(ctx, evt.From, node)
		}
	case *events.CallReject:
		node := wrapCall(evt.From, evt.Data)
		if p.OnIncomingTerminate != nil {
			p.OnIncomingTerminate(ctx, evt.From, node)
		}
	}
}

func (p *NativeProvider) emitEvent(evtType core.EventType, payload map[string]any) {
	evt := core.NewEvent(evtType, p.id, "", p.tenantID, payload)
	p.subMu.Lock()
	defer p.subMu.Unlock()
	for _, ch := range p.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

func wrapCall(from types.JID, inner *waBinary.Node) *waBinary.Node {
	if inner == nil {
		return nil
	}
	return &waBinary.Node{
		Tag:     "call",
		Attrs:   waBinary.Attrs{"from": from, "id": signaling.GenerateCallStanzaID()},
		Content: []waBinary.Node{*inner},
	}
}

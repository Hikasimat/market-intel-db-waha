package waha

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"wacalls/internal/core"
	voipCore "wacalls/internal/voip/core"
)

// Config defines the configuration needed to connect to a WAHA instance.
type Config struct {
	ID                  string        `json:"id"`
	TenantID            string        `json:"tenant_id"`
	Name                string        `json:"name"`
	BaseURL             string        `json:"base_url"`
	APIKey              string        `json:"api_key"`
	SessionName         string        `json:"session_name"`
	Engine              string        `json:"engine,omitempty"` // "NOWEB", "WEBJS", "BAILEYS"
	EnableSharedHandoff bool          `json:"enable_shared_handoff,omitempty"`
	HTTPTimeout         time.Duration `json:"http_timeout,omitempty"`
	Log                 *slog.Logger  `json:"-"`
}

// WAHAProvider implements core.WhatsAppProvider for WAHA.
type WAHAProvider struct {
	cfg        Config
	httpClient *http.Client
	log        *slog.Logger

	mu       sync.RWMutex
	state    string // "init", "connecting", "qr", "open", "logged_out", "failed"
	lastQR   string
	qrExpire time.Time
	jid      string
	engine   string

	subs  []chan core.Event
	subMu sync.Mutex
}

// NewWAHAProvider constructs a new WAHAProvider.
func NewWAHAProvider(cfg Config) *WAHAProvider {
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 10 * time.Second
	}
	if cfg.SessionName == "" {
		cfg.SessionName = "default"
	}
	if cfg.TenantID == "" {
		cfg.TenantID = "default"
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:3000"
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")

	return &WAHAProvider{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: cfg.HTTPTimeout,
		},
		log:    cfg.Log.With("provider", "waha", "session", cfg.ID),
		state:  "init",
		engine: cfg.Engine,
	}
}

func (p *WAHAProvider) ID() string       { return p.cfg.ID }
func (p *WAHAProvider) TenantID() string { return p.cfg.TenantID }
func (p *WAHAProvider) Type() string     { return "waha" }
func (p *WAHAProvider) Name() string     { return p.cfg.Name }

func (p *WAHAProvider) GetCapabilities() core.ProviderCapabilities {
	p.mu.RLock()
	engine := strings.ToUpper(p.engine)
	handoff := p.cfg.EnableSharedHandoff
	p.mu.RUnlock()

	// Analysis of WAHA architecture:
	// WAHA (WhatsApp HTTP API) operates primarily as a messaging gateway.
	// Its default engines (WEBJS, BAILEYS) terminate WhatsApp Web WebSocket sessions
	// and do NOT expose WhatsApp VoIP call signaling, STUN tokens, or SCTP relay media streams.
	// Only if WAHA is running with NOWEB (whatsmeow) AND has shared device handoff configured
	// can VoIP signaling be supported.
	if engine == "NOWEB" && handoff {
		return core.ProviderCapabilities{
			HasNativeAuth:               false,
			HasExternalQROwner:          true,
			SupportsSessionReuse:        true,
			SupportsVoIPSignaling:       true,
			SupportsIncomingCalls:       true,
			SupportsOutgoingCalls:       true,
			SupportsCallAcceptance:      true,
			SupportsCallRejection:       true,
			SupportsCallTermination:     true,
			SupportsBidirectionalAudio:  true,
			SupportsCallEvents:          true,
			SupportsConcurrentCalls:     true,
			MaxConcurrentCalls:          4,
		}
	}

	return core.ProviderCapabilities{
		HasNativeAuth:              false,
		HasExternalQROwner:         true,
		SupportsSessionReuse:       true,
		SupportsVoIPSignaling:      false,
		SupportsIncomingCalls:      false,
		SupportsOutgoingCalls:      false,
		SupportsCallAcceptance:     false,
		SupportsCallRejection:      false,
		SupportsCallTermination:    false,
		SupportsBidirectionalAudio: false,
		SupportsCallEvents:         false,
		SupportsConcurrentCalls:    false,
		MaxConcurrentCalls:         0,
		UnsupportedReason:          "WAHA engine does not expose WhatsApp VoIP call signaling or WebRTC media relay. Calling is disabled.",
	}
}

func (p *WAHAProvider) Connect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "connecting"
	p.mu.Unlock()

	// Verify connection to WAHA API and fetch session state
	status, err := p.fetchSessionStatusFromAPI(ctx)
	if err != nil {
		p.mu.Lock()
		p.state = "failed"
		p.mu.Unlock()
		return fmt.Errorf("failed to reach WAHA at %s: %w", p.cfg.BaseURL, err)
	}

	p.updateInternalState(status)
	return nil
}

func (p *WAHAProvider) Disconnect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "logged_out"
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *WAHAProvider) GetSessionStatus(ctx context.Context) (core.SessionStatus, error) {
	// Query WAHA live status
	apiStatus, err := p.fetchSessionStatusFromAPI(ctx)
	if err == nil {
		p.updateInternalState(apiStatus)
	}

	p.mu.RLock()
	defer p.mu.RUnlock()

	caps := p.GetCapabilities()
	canCall := (p.state == "open") && caps.SupportsVoIPSignaling

	reason := ""
	if !caps.SupportsVoIPSignaling {
		reason = caps.UnsupportedReason
	} else if p.state != "open" {
		reason = "WAHA session is not yet paired or working"
	}

	return core.SessionStatus{
		ID:        p.cfg.ID,
		SessionID: p.cfg.ID,
		TenantID:  p.cfg.TenantID,
		Name:      p.cfg.Name,
		Provider:  "waha",
		State:     p.state,
		Paired:    p.state == "open",
		JID:       p.jid,
		CanCall:   canCall,
		Reason:    reason,
		UpdatedAt: time.Now().UnixMilli(),
	}, nil
}

func (p *WAHAProvider) GetQRCode(ctx context.Context) (core.QRCode, error) {
	// Directly query WAHA's QR endpoint
	url := fmt.Sprintf("%s/api/%s/auth/qr", p.cfg.BaseURL, p.cfg.SessionName)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return core.QRCode{}, err
	}
	p.setHeaders(req)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return core.QRCode{}, fmt.Errorf("waha qr fetch error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		p.mu.RLock()
		defer p.mu.RUnlock()
		if p.lastQR != "" {
			return core.QRCode{Code: p.lastQR, ExpiresAt: p.qrExpire, Source: "waha"}, nil
		}
		return core.QRCode{}, fmt.Errorf("WAHA returned HTTP %d for QR code", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return core.QRCode{}, err
	}

	var qrResp struct {
		Raw   string `json:"raw"`
		Image string `json:"image"`
	}
	if err := json.Unmarshal(body, &qrResp); err == nil && qrResp.Raw != "" {
		p.mu.Lock()
		p.lastQR = qrResp.Raw
		p.qrExpire = time.Now().Add(25 * time.Second)
		p.state = "qr"
		p.mu.Unlock()
		return core.QRCode{Code: qrResp.Raw, ExpiresAt: p.qrExpire, Source: "waha"}, nil
	}

	code := strings.TrimSpace(string(body))
	p.mu.Lock()
	p.lastQR = code
	p.qrExpire = time.Now().Add(25 * time.Second)
	p.state = "qr"
	p.mu.Unlock()

	return core.QRCode{
		Code:      code,
		ExpiresAt: p.qrExpire,
		Source:    "waha",
	}, nil
}

func (p *WAHAProvider) Pair(ctx context.Context) error {
	// WAHA owns the QR generation; request session start in WAHA
	url := fmt.Sprintf("%s/api/sessions/start", p.cfg.BaseURL)
	payload := fmt.Sprintf(`{"name": "%s"}`, p.cfg.SessionName)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(payload))
	if err != nil {
		return err
	}
	p.setHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	p.mu.Lock()
	p.state = "connecting"
	p.mu.Unlock()
	return nil
}

func (p *WAHAProvider) Logout(ctx context.Context) error {
	url := fmt.Sprintf("%s/api/sessions/logout", p.cfg.BaseURL)
	payload := fmt.Sprintf(`{"name": "%s"}`, p.cfg.SessionName)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(payload))
	if err != nil {
		return err
	}
	p.setHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	p.mu.Lock()
	p.state = "logged_out"
	p.lastQR = ""
	p.jid = ""
	p.mu.Unlock()

	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *WAHAProvider) GetVoipSocket() (voipCore.VoipSocket, error) {
	caps := p.GetCapabilities()
	if !caps.SupportsVoIPSignaling {
		return nil, core.ErrVoipUnsupported
	}
	return nil, core.ErrVoipUnsupported
}

func (p *WAHAProvider) SubscribeEvents(ctx context.Context) (<-chan core.Event, error) {
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

func (p *WAHAProvider) Close() error {
	p.subMu.Lock()
	for _, ch := range p.subs {
		close(ch)
	}
	p.subs = nil
	p.subMu.Unlock()
	return nil
}

func (p *WAHAProvider) setHeaders(req *http.Request) {
	if p.cfg.APIKey != "" {
		req.Header.Set("X-Api-Key", p.cfg.APIKey)
		req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	}
}

type wahaSessionResponse struct {
	Name   string `json:"name"`
	Status string `json:"status"` // "STARTING", "SCAN_QR_CODE", "WORKING", "FAILED", "STOPPED"
	Engine string `json:"engine,omitempty"`
	Me     struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"me,omitempty"`
}

func (p *WAHAProvider) fetchSessionStatusFromAPI(ctx context.Context) (*wahaSessionResponse, error) {
	url := fmt.Sprintf("%s/api/sessions/%s", p.cfg.BaseURL, p.cfg.SessionName)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	p.setHeaders(req)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("WAHA returned status %d", resp.StatusCode)
	}

	var res wahaSessionResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (p *WAHAProvider) updateInternalState(res *wahaSessionResponse) {
	if res == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	if res.Engine != "" {
		p.engine = res.Engine
	}
	if res.Me.ID != "" {
		p.jid = res.Me.ID
	}

	var newState string
	switch strings.ToUpper(res.Status) {
	case "WORKING":
		newState = "open"
	case "SCAN_QR_CODE":
		newState = "qr"
	case "STARTING":
		newState = "connecting"
	case "STOPPED", "FAILED":
		newState = "logged_out"
	default:
		newState = "connecting"
	}

	changed := (p.state != newState)
	p.state = newState

	if changed {
		p.emitEvent(core.EventAuthState, map[string]any{
			"state":  newState,
			"paired": newState == "open",
			"jid":    p.jid,
		})
	}
}

func (p *WAHAProvider) emitEvent(evtType core.EventType, payload map[string]any) {
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


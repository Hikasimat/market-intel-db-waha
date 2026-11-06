package providers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"wacalls/internal/core"
	"wacalls/internal/providers/bridge"
	"wacalls/internal/providers/custom"
	"wacalls/internal/providers/native"
	"wacalls/internal/providers/waha"

	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Registry manages active providers partitioned by tenant.
type Registry struct {
	mu        sync.RWMutex
	providers map[string]core.WhatsAppProvider // key: tenantID:providerID
	container *sqlstore.Container
	log       *slog.Logger
	waLogger  waLog.Logger
}

// NewRegistry creates a new provider registry.
func NewRegistry(container *sqlstore.Container, log *slog.Logger, waLogger waLog.Logger) *Registry {
	if log == nil {
		log = slog.Default()
	}
	if waLogger == nil {
		waLogger = waLog.Noop
	}
	return &Registry{
		providers: make(map[string]core.WhatsAppProvider),
		container: container,
		log:       log,
		waLogger:  waLogger,
	}
}

func key(tenantID, providerID string) string {
	if tenantID == "" {
		tenantID = "default"
	}
	return tenantID + ":" + providerID
}

// Register registers an already instantiated provider.
func (r *Registry) Register(p core.WhatsAppProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[key(p.TenantID(), p.ID())] = p
}

// Unregister removes a provider.
func (r *Registry) Unregister(tenantID, providerID string) core.WhatsAppProvider {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := key(tenantID, providerID)
	p, ok := r.providers[k]
	if ok {
		delete(r.providers, k)
	}
	return p
}

// Get returns the provider by tenantID and providerID.
func (r *Registry) Get(tenantID, providerID string) (core.WhatsAppProvider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.providers[key(tenantID, providerID)]
	return p, ok
}

// List returns all providers for a given tenant.
func (r *Registry) List(tenantID string) []core.WhatsAppProvider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if tenantID == "" {
		tenantID = "default"
	}
	prefix := tenantID + ":"
	var out []core.WhatsAppProvider
	for k, p := range r.providers {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, p)
		}
	}
	return out
}

// CreateProvider instantiates a new provider from ProviderConfig.
func (r *Registry) CreateProvider(ctx context.Context, cfg core.ProviderConfig) (core.WhatsAppProvider, error) {
	if cfg.TenantID == "" {
		cfg.TenantID = "default"
	}

	switch cfg.Type {
	case "bridge":
		bridgeURL, _ := cfg.Settings["bridge_url"].(string)
		token, _ := cfg.Settings["internal_token"].(string)
		p := bridge.NewBridgeProvider(bridge.Config{
			ID:            cfg.ID,
			TenantID:      cfg.TenantID,
			Name:          cfg.Name,
			BridgeURL:     bridgeURL,
			InternalToken: token,
			Log:           r.log,
		})
		r.Register(p)
		return p, nil

	case "native":
		if r.container == nil {
			return nil, fmt.Errorf("native provider requires sqlstore container")
		}
		dev := r.container.NewDevice()
		p := native.NewNativeProvider(native.Config{
			ID:        cfg.ID,
			TenantID:  cfg.TenantID,
			Name:      cfg.Name,
			Container: r.container,
			Device:    dev,
			Log:       r.log,
			WALogger:  r.waLogger,
		})
		r.Register(p)
		return p, nil

	case "waha":
		baseURL, _ := cfg.Settings["base_url"].(string)
		apiKey, _ := cfg.Settings["api_key"].(string)
		sessionName, _ := cfg.Settings["session_name"].(string)
		engine, _ := cfg.Settings["engine"].(string)
		handoff, _ := cfg.Settings["enable_shared_handoff"].(bool)

		p := waha.NewWAHAProvider(waha.Config{
			ID:                  cfg.ID,
			TenantID:            cfg.TenantID,
			Name:                cfg.Name,
			BaseURL:             baseURL,
			APIKey:              apiKey,
			SessionName:         sessionName,
			Engine:              engine,
			EnableSharedHandoff: handoff,
			Log:                 r.log,
		})
		r.Register(p)
		return p, nil

	case "custom":
		p := custom.NewCustomProvider(custom.Config{
			ID:       cfg.ID,
			TenantID: cfg.TenantID,
			Name:     cfg.Name,
			Capabilities: core.ProviderCapabilities{
				HasNativeAuth:              false,
				HasExternalQROwner:         true,
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
				MaxConcurrentCalls:         5,
			},
		})
		r.Register(p)
		return p, nil

	default:
		return nil, fmt.Errorf("unsupported provider type: %s", cfg.Type)
	}
}


package session

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"wacalls/internal/core"
	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/providers/native"

	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Coordinator manages multi-tenant sessions, connecting providers with the calling engine and database.
type Coordinator struct {
	appCtx    context.Context
	store     *Store
	providers *providers.Registry
	engine    *Engine
	broker    *events.Broker
	container *sqlstore.Container
	log       *slog.Logger
	waLogger  waLog.Logger
	mu        sync.RWMutex
}

// NewCoordinator constructs a Coordinator.
func NewCoordinator(ctx context.Context, store *Store, reg *providers.Registry, engine *Engine, broker *events.Broker, container *sqlstore.Container, log *slog.Logger, waLogger waLog.Logger) *Coordinator {
	if log == nil {
		log = slog.Default()
	}
	if waLogger == nil {
		waLogger = waLog.Noop
	}
	c := &Coordinator{
		appCtx:    ctx,
		store:     store,
		providers: reg,
		engine:    engine,
		broker:    broker,
		container: container,
		log:       log.With("component", "session_coordinator"),
		waLogger:  waLogger,
	}

	broker.SnapshotFn = func(tenantID, clientID string) []core.Event {
		sessions := c.ListSessions(tenantID)
		snaps := []core.Event{
			core.NewEvent(core.EventSessionList, "", "", tenantID, map[string]any{
				"sessions": sessions,
			}),
		}
		for _, s := range sessions {
			if s.State == "qr" {
				if qr, err := c.GetQRCode(context.Background(), tenantID, s.ID); err == nil && qr.Code != "" {
					snaps = append(snaps, core.NewEvent(core.EventSessionQR, s.ID, "", tenantID, map[string]any{
						"qr": qr.Code,
					}))
				}
			}
		}
		calls := c.engine.ListCalls(tenantID, "")
		snaps = append(snaps, core.NewEvent(core.EventCallList, "", "", tenantID, map[string]any{
			"calls": calls,
		}))
		return snaps
	}

	return c
}

// Restore restores stored sessions on service restart.
func (c *Coordinator) Restore(ctx context.Context) error {
	sessions, err := c.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}

	for _, s := range sessions {
		if s.TenantID == "" {
			s.TenantID = "default"
		}

		provCfg, err := c.store.GetProvider(ctx, s.TenantID, s.ProviderID)
		if err != nil || provCfg == nil {
			// Fallback: check if it was a native session
			provCfg = &core.ProviderConfig{
				ID:        s.ProviderID,
				TenantID:  s.TenantID,
				Type:      "native",
				Name:      s.Name,
				IsDefault: true,
			}
			_ = c.store.SaveProvider(ctx, *provCfg)
		}

		var p core.WhatsAppProvider
		if provCfg.Type == "native" && c.container != nil {
			if s.JID == "" {
				_ = c.store.DeleteSession(ctx, s.TenantID, s.ID)
				continue
			}
			jid, err := types.ParseJID(s.JID)
			if err != nil {
				c.log.Warn("dropping session with unparseable jid", "session", s.ID, "jid", s.JID)
				_ = c.store.DeleteSession(ctx, s.TenantID, s.ID)
				continue
			}
			device, err := c.container.GetDevice(ctx, jid)
			if err != nil || device == nil {
				c.log.Warn("dropping session with no stored device", "session", s.ID, "jid", s.JID)
				_ = c.store.DeleteSession(ctx, s.TenantID, s.ID)
				continue
			}
			nat := native.NewNativeProvider(native.Config{
				ID:        s.ID,
				TenantID:  s.TenantID,
				Name:      s.Name,
				Container: c.container,
				Device:    device,
				Log:       c.log,
				WALogger:  c.waLogger,
			})
			p = nat
		} else {
			p, err = c.providers.CreateProvider(ctx, *provCfg)
			if err != nil {
				c.log.Error("failed restoring provider", "session", s.ID, "err", err)
				continue
			}
		}

		c.providers.Register(p)
		c.engine.AttachProvider(p)
		c.listenProviderEvents(p)

		if err := p.Connect(c.appCtx); err != nil {
			c.log.Error("provider connect failed on restore", "session", s.ID, "err", err)
		}
	}

	c.log.Info("sessions restored successfully", "count", len(sessions))
	return nil
}

// Create creates a new WhatsApp session with an optional custom provider.
func (c *Coordinator) Create(ctx context.Context, tenantID, name, providerType string, settings map[string]any) (string, error) {
	if tenantID == "" {
		tenantID = "default"
	}
	if name == "" {
		name = "Session"
	}
	if providerType == "" {
		providerType = "native"
	}

	sessionID := GenerateID()
	providerID := sessionID // 1-to-1 default pairing

	provCfg := core.ProviderConfig{
		ID:        providerID,
		TenantID:  tenantID,
		Type:      providerType,
		Name:      name,
		Settings:  settings,
		IsDefault: true,
	}

	if err := c.store.SaveProvider(ctx, provCfg); err != nil {
		return "", err
	}

	p, err := c.providers.CreateProvider(ctx, provCfg)
	if err != nil {
		return "", err
	}

	if err := c.store.SaveSession(ctx, SessionRecord{
		ID:         sessionID,
		TenantID:   tenantID,
		ProviderID: providerID,
		Name:       name,
		CreatedAt:  time.Now().UnixMilli(),
	}); err != nil {
		return "", err
	}

	c.providers.Register(p)
	c.engine.AttachProvider(p)
	c.listenProviderEvents(p)

	if err := p.Connect(c.appCtx); err != nil {
		c.log.Error("failed starting provider connect", "session", sessionID, "err", err)
	}

	c.broker.Publish(core.NewEvent(core.EventSessionList, "", "", tenantID, map[string]any{
		"sessions": c.ListSessions(tenantID),
	}))

	c.log.Info("session created", "session", sessionID, "provider", providerType, "tenant", tenantID)
	return sessionID, nil
}

// GetSessionStatus returns live status of the session.
func (c *Coordinator) GetSessionStatus(ctx context.Context, tenantID, sessionID string) (core.SessionStatus, error) {
	p, ok := c.providers.Get(tenantID, sessionID)
	if !ok {
		return core.SessionStatus{}, core.ErrNotFound
	}
	return p.GetSessionStatus(ctx)
}

// GetQRCode returns the active QR code for pairing.
func (c *Coordinator) GetQRCode(ctx context.Context, tenantID, sessionID string) (core.QRCode, error) {
	p, ok := c.providers.Get(tenantID, sessionID)
	if !ok {
		return core.QRCode{}, core.ErrNotFound
	}
	return p.GetQRCode(ctx)
}

// Pair re-initiates pairing for a session.
func (c *Coordinator) Pair(ctx context.Context, tenantID, sessionID string) error {
	p, ok := c.providers.Get(tenantID, sessionID)
	if !ok {
		return core.ErrNotFound
	}
	return p.Pair(c.appCtx)
}

// Logout disconnects and clears authentication for a session.
func (c *Coordinator) Logout(ctx context.Context, tenantID, sessionID string) error {
	p, ok := c.providers.Get(tenantID, sessionID)
	if !ok {
		return core.ErrNotFound
	}
	if err := p.Logout(ctx); err != nil {
		return err
	}
	_ = c.store.SetSessionJID(ctx, tenantID, sessionID, "")
	c.broker.Publish(core.NewEvent(core.EventSessionList, "", "", tenantID, map[string]any{
		"sessions": c.ListSessions(tenantID),
	}))
	return nil
}

// Delete removes a session and its provider completely.
func (c *Coordinator) Delete(ctx context.Context, tenantID, sessionID string) error {
	p, ok := c.providers.Get(tenantID, sessionID)
	if ok {
		_ = p.Close()
		c.providers.Unregister(tenantID, sessionID)
	}
	_ = c.store.DeleteSession(ctx, tenantID, sessionID)
	_ = c.store.DeleteProvider(ctx, tenantID, sessionID)

	c.broker.Publish(core.NewEvent(core.EventSessionList, "", "", tenantID, map[string]any{
		"sessions": c.ListSessions(tenantID),
	}))
	return nil
}

// ListSessions returns status summaries for all sessions belonging to the tenant.
func (c *Coordinator) ListSessions(tenantID string) []core.SessionStatus {
	if tenantID == "" {
		tenantID = "default"
	}
	provs := c.providers.List(tenantID)
	out := make([]core.SessionStatus, 0, len(provs))
	for _, p := range provs {
		st, err := p.GetSessionStatus(context.Background())
		if err == nil {
			out = append(out, st)
		}
	}
	return out
}

// TeardownAll terminates all active connections gracefully.
func (c *Coordinator) TeardownAll() {
	c.engine.TeardownAll()
	for _, p := range c.providers.List("") {
		_ = p.Close()
	}
}

func (c *Coordinator) listenProviderEvents(p core.WhatsAppProvider) {
	ch, err := p.SubscribeEvents(c.appCtx)
	if err != nil {
		return
	}
	go func() {
		for evt := range ch {
			switch evt.Type {
			case core.EventAuthState:
				if st, err := p.GetSessionStatus(context.Background()); err == nil {
					if st.JID != "" {
						_ = c.store.SetSessionJID(context.Background(), p.TenantID(), p.ID(), st.JID)
					}
				}
				c.broker.Publish(core.NewEvent(core.EventSessionList, "", "", p.TenantID(), map[string]any{
					"sessions": c.ListSessions(p.TenantID()),
				}))
			}
			c.broker.Publish(evt)
		}
	}()
}

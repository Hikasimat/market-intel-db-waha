package session

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"wacalls/internal/core"
	_ "modernc.org/sqlite"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test_wacalls.db")
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestStoreSessionsAndProviders(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	store, err := NewStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Providers
	prov := core.ProviderConfig{
		ID:        "prov-1",
		TenantID:  "tenant-a",
		Type:      "native",
		Name:      "Native WhatsApp",
		IsDefault: true,
	}
	if err := store.SaveProvider(ctx, prov); err != nil {
		t.Fatalf("save provider: %v", err)
	}

	gotProv, err := store.GetProvider(ctx, "tenant-a", "prov-1")
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	if gotProv.Name != "Native WhatsApp" {
		t.Fatalf("unexpected provider name: %s", gotProv.Name)
	}

	// 2. Tenant isolation in providers
	_, err = store.GetProvider(ctx, "tenant-b", "prov-1")
	if err != core.ErrNotFound {
		t.Fatalf("expected ErrNotFound for cross-tenant provider get, got %v", err)
	}

	// 3. Sessions
	sess := SessionRecord{
		ID:         "sess-1",
		TenantID:   "tenant-a",
		ProviderID: "prov-1",
		Name:       "Sales Line",
		JID:        "12345@s.whatsapp.net",
	}
	if err := store.SaveSession(ctx, sess); err != nil {
		t.Fatalf("save session: %v", err)
	}

	gotSess, err := store.GetSession(ctx, "tenant-a", "sess-1")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if gotSess.JID != "12345@s.whatsapp.net" {
		t.Fatalf("unexpected JID: %s", gotSess.JID)
	}

	// 4. Call records
	rec := core.CallRecord{
		CallID:    "call-100",
		SessionID: "sess-1",
		TenantID:  "tenant-a",
		Direction: "outbound",
		Peer:      "987654@s.whatsapp.net",
		StartedAt: 1000,
		Status:    "ringing",
	}
	if err := store.UpsertCall(ctx, rec); err != nil {
		t.Fatalf("upsert call: %v", err)
	}

	callGot, err := store.GetCall(ctx, "tenant-a", "call-100")
	if err != nil {
		t.Fatalf("get call: %v", err)
	}
	if callGot.Status != "ringing" {
		t.Fatalf("unexpected call status: %s", callGot.Status)
	}
}


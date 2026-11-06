package session

import (
	"context"
	"log/slog"
	"testing"

	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/providers/custom"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func TestCoordinatorRegistryAndTenantIsolation(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	store, _ := NewStore(ctx, db)
	reg := providers.NewRegistry(nil, slog.Default(), waLog.Noop)
	broker := events.NewBroker()
	engine := NewEngine(reg, store, broker, 5, nil, slog.Default())
	coord := NewCoordinator(ctx, store, reg, engine, broker, nil, slog.Default(), waLog.Noop)

	p1 := custom.NewCustomProvider(custom.Config{ID: "p1", TenantID: "tenant-A", Name: "Account A"})
	p2 := custom.NewCustomProvider(custom.Config{ID: "p2", TenantID: "tenant-B", Name: "Account B"})
	reg.Register(p1)
	reg.Register(p2)

	listA := coord.ListSessions("tenant-A")
	if len(listA) != 1 {
		t.Fatalf("expected 1 session for tenant-A, got %d", len(listA))
	}
	if listA[0].SessionID != "p1" {
		t.Fatalf("expected p1, got %s", listA[0].SessionID)
	}

	listB := coord.ListSessions("tenant-B")
	if len(listB) != 1 {
		t.Fatalf("expected 1 session for tenant-B, got %d", len(listB))
	}
	if listB[0].SessionID != "p2" {
		t.Fatalf("expected p2, got %s", listB[0].SessionID)
	}
}


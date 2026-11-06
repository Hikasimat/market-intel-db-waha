package events

import (
	"testing"
	"time"

	"wacalls/internal/core"
)

func TestBrokerPublishSubscribe(t *testing.T) {
	b := NewBroker()
	ch, unsubscribe := b.Subscribe("tenant-1", "client-1")
	defer unsubscribe()

	evt := core.NewEvent(core.EventCallStatus, "session-1", "call-1", "tenant-1", map[string]any{"status": "ringing"})
	b.Publish(evt)

	select {
	case received := <-ch:
		if received.Type != core.EventCallStatus {
			t.Fatalf("expected EventCallStatus, got %s", received.Type)
		}
		if received.TenantID != "tenant-1" {
			t.Fatalf("expected tenant-1, got %s", received.TenantID)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestBrokerTenantIsolation(t *testing.T) {
	b := NewBroker()
	ch1, unsub1 := b.Subscribe("tenant-1", "client-1")
	defer unsub1()

	ch2, unsub2 := b.Subscribe("tenant-2", "client-2")
	defer unsub2()

	// Publish event for tenant-1 only
	b.Publish(core.NewEvent(core.EventCallIncoming, "session-1", "call-1", "tenant-1", nil))

	select {
	case <-ch1:
		// Received as expected
	case <-time.After(500 * time.Millisecond):
		t.Fatal("tenant-1 did not receive its own event")
	}

	select {
	case evt := <-ch2:
		t.Fatalf("tenant-2 received tenant-1's private event: %+v", evt)
	case <-time.After(100 * time.Millisecond):
		// Success: tenant-2 received nothing
	}
}


package events

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"wacalls/internal/core"
)

type subscriber struct {
	id       uint64
	tenantID string
	clientID string
	ch       chan core.Event
}

// Broker distributes real-time events to connected HTTP clients (SSE) with tenant isolation.
type Broker struct {
	mu          sync.RWMutex
	subscribers map[uint64]*subscriber
	nextID      atomic.Uint64

	// SnapshotFn provides initial state payloads for newly connected SSE clients
	SnapshotFn func(tenantID, clientID string) []core.Event
}

// NewBroker creates a new event broker.
func NewBroker() *Broker {
	return &Broker{
		subscribers: make(map[uint64]*subscriber),
	}
}

// Publish broadcasts an event only to subscribers belonging to the event's TenantID.
func (b *Broker) Publish(evt core.Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, sub := range b.subscribers {
		// Enforce tenant isolation: Default or empty tenant matches only default
		if sub.tenantID == evt.TenantID || evt.TenantID == "" {
			select {
			case sub.ch <- evt:
			default:
				// If channel full, drop to avoid blocking publishers
			}
		}
	}
}

// Subscribe registers a new subscriber channel.
func (b *Broker) Subscribe(tenantID, clientID string) (<-chan core.Event, func()) {
	id := b.nextID.Add(1)
	ch := make(chan core.Event, 64)
	sub := &subscriber{
		id:       id,
		tenantID: tenantID,
		clientID: clientID,
		ch:       ch,
	}

	b.mu.Lock()
	b.subscribers[id] = sub
	b.mu.Unlock()

	unsubscribe := func() {
		b.mu.Lock()
		delete(b.subscribers, id)
		close(ch)
		b.mu.Unlock()
	}

	return ch, unsubscribe
}

// ServeSSE handles an incoming HTTP Server-Sent Events stream.
func (b *Broker) ServeSSE(w http.ResponseWriter, r *http.Request, tenantID, clientID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsubscribe := b.Subscribe(tenantID, clientID)
	defer unsubscribe()

	// Send initial snapshot events if configured
	if b.SnapshotFn != nil {
		for _, evt := range b.SnapshotFn(tenantID, clientID) {
			b.writeSSE(w, flusher, evt)
		}
	}

	keepalive := time.NewTicker(10 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case evt, open := <-ch:
			if !open {
				return
			}
			b.writeSSE(w, flusher, evt)
		case <-keepalive.C:
			_, _ = fmt.Fprintf(w, "data: {\"type\":\"ping\"}\n\n")
			flusher.Flush()
		}
	}
}

func (b *Broker) writeSSE(w http.ResponseWriter, flusher http.Flusher, evt core.Event) {
	data, err := json.Marshal(evt)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()
}


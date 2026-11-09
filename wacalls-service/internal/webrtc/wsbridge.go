package webrtc

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"wacalls/internal/voip/media"

	"github.com/coder/websocket"
)

// WSBridge carries 16 kHz mono raw Int16 LE PCM between the browser and CallManager over a WebSocket.
type WSBridge struct {
	conn         *websocket.Conn
	log          *slog.Logger
	OnBrowserPCM func(pcm []float32)
	closeOnce    sync.Once
	done         chan struct{}
}

// NewWSBridge creates a new WebSocket bridge instance.
func NewWSBridge(conn *websocket.Conn, log *slog.Logger) *WSBridge {
	if log == nil {
		log = slog.Default()
	}
	return &WSBridge{
		conn: conn,
		log:  log,
		done: make(chan struct{}),
	}
}

// WritePCM converts 16 kHz float32 PCM to Int16 LE bytes and transmits it to the browser WebSocket.
func (b *WSBridge) WritePCM(pcm []float32) error {
	select {
	case <-b.done:
		return nil
	default:
	}
	if len(pcm) == 0 {
		return nil
	}
	data := media.PCMFloat32ToInt16LE(pcm)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	return b.conn.Write(ctx, websocket.MessageBinary, data)
}

// Close gracefully closes the WebSocket connection.
func (b *WSBridge) Close() {
	b.closeOnce.Do(func() {
		close(b.done)
		_ = b.conn.Close(websocket.StatusNormalClosure, "call ended")
	})
}

// Run loops reading incoming Int16 LE PCM chunks from the browser and forwarding them to CallManager.
func (b *WSBridge) Run(ctx context.Context) {
	for {
		select {
		case <-b.done:
			return
		case <-ctx.Done():
			b.Close()
			return
		default:
		}
		typ, data, err := b.conn.Read(ctx)
		if err != nil {
			break
		}
		if typ == websocket.MessageBinary && len(data) > 0 {
			if cb := b.OnBrowserPCM; cb != nil {
				cb(media.PCMInt16LEToFloat32(data))
			}
		}
	}
	b.Close()
}


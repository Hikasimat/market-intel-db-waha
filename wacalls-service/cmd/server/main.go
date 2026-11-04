package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	_ = flag.String("db", "", "deprecated: the engine no longer keeps its own WhatsApp login (kept for CLI compatibility)")
	staticDir := flag.String("static", "client/dist", "static client directory (optional)")
	debug := flag.Bool("debug", false, "verbose logging")
	maxCalls := flag.Int("max-calls-per-session", 8, "max concurrent calls per session (0 = unlimited)")
	bridgeURL := flag.String("bridge-url", "", "base URL of the Node.js host exposing /internal/bridge/rpc (env WACALLS_BRIDGE_URL)")
	flag.Parse()

	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	base := *bridgeURL
	if base == "" {
		base = os.Getenv("WACALLS_BRIDGE_URL")
	}
	if base == "" {
		base = "http://127.0.0.1:3000"
	}
	rpc := newRPCClient(base, os.Getenv("WACALLS_INTERNAL_TOKEN"))

	srv, err := newServer(ctx, *staticDir, *maxCalls, rpc, log)
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}
	defer srv.sessions.disconnectAll()

	httpSrv := &http.Server{Addr: *addr, Handler: srv.routes()}
	go func() {
		log.Info("HTTP server listening (Baileys-bridged mode)", "addr", *addr, "bridge", base)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}

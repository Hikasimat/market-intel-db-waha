package main

import (
	"context"
	"log/slog"
)

type server struct {
	broker    *Broker
	sessions  *SessionManager
	log       *slog.Logger
	staticDir string
}

func newServer(ctx context.Context, staticDir string, maxCalls int, rpc *rpcClient, log *slog.Logger) (*server, error) {
	broker := NewBroker()
	mgr := newSessionManager(ctx, broker, log, maxCalls, rpc)
	broker.SnapshotFn = mgr.snapshotEvents

	return &server{broker: broker, sessions: mgr, log: log, staticDir: staticDir}, nil
}

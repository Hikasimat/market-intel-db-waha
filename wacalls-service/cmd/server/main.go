package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"wacalls/internal/api"
	"wacalls/internal/config"
	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/session"

	"go.mau.fi/whatsmeow"
	waStore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
)

func main() {
	cfg := config.LoadFromEnv()

	addr := flag.String("addr", cfg.ListenAddr, "HTTP listen address")
	dbPath := flag.String("db", cfg.DatabasePath, "SQLite session database path")
	staticDir := flag.String("static", cfg.StaticDir, "static client directory")
	debug := flag.Bool("debug", cfg.LogLevel == "debug", "verbose logging")
	maxCalls := flag.Int("max-calls-per-session", cfg.MaxCallsPerSession, "max concurrent calls per session (0 = unlimited)")
	apiKey := flag.String("api-key", cfg.APIKey, "API key for REST authentication")
	defaultProvider := flag.String("default-provider", cfg.DefaultProvider, "default provider type (native, waha, custom, bridge)")
	bridgeURL := flag.String("bridge-url", os.Getenv("WACALLS_BRIDGE_URL"), "base URL of the Node.js host exposing /internal/bridge/rpc")
	flag.Parse()

	if *bridgeURL == "" {
		*bridgeURL = os.Getenv("BRIDGE_URL")
	}
	if *bridgeURL == "" {
		*bridgeURL = "http://127.0.0.1:3000"
	}
	if *defaultProvider == "native" && *bridgeURL != "" {
		*defaultProvider = "bridge"
	}

	if *apiKey == "" {
		*apiKey = os.Getenv("WACALLS_INTERNAL_TOKEN")
	}
	if *apiKey == "" {
		*apiKey = os.Getenv("WACALLS_TOKEN")
	}

	cfg.ListenAddr = *addr
	cfg.DatabasePath = *dbPath
	cfg.StaticDir = *staticDir
	cfg.MaxCallsPerSession = *maxCalls
	cfg.APIKey = *apiKey
	cfg.DefaultProvider = *defaultProvider

	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := openDB(cfg.DatabasePath)
	if err != nil {
		logger.Error("failed opening SQLite database", "err", err, "path", cfg.DatabasePath)
		os.Exit(1)
	}
	defer db.Close()

	waLogger := waLog.Noop
	if *debug {
		waLogger = waLog.Stdout("WA", "INFO", true)
	}

	// Update WhatsApp Web client version to prevent "err-client-outdated" errors
	verCtx, verCancel := context.WithTimeout(ctx, 4*time.Second)
	latestVer, err := whatsmeow.GetLatestVersion(verCtx, nil)
	verCancel()
	if err == nil && latestVer != nil {
		waStore.SetWAVersion(*latestVer)
		logger.Info("updated WhatsApp Web client version", "version", latestVer.String())
	} else {
		fallbackVer := waStore.WAVersionContainer{2, 3000, 1053393627}
		waStore.SetWAVersion(fallbackVer)
		logger.Info("using verified WhatsApp Web version", "version", fallbackVer.String())
	}

	container := sqlstore.NewWithDB(db, "sqlite3", waLogger)
	if err := container.Upgrade(ctx); err != nil {
		logger.Error("failed upgrading whatsmeow container schema", "err", err)
		os.Exit(1)
	}

	store, err := session.NewStore(ctx, db)
	if err != nil {
		logger.Error("failed initializing session store", "err", err)
		os.Exit(1)
	}

	registry := providers.NewRegistry(container, logger, waLogger)
	broker := events.NewBroker()
	engine := session.NewEngine(registry, store, broker, cfg.MaxCallsPerSession, cfg.WebRTCStunServers, logger)
	coord := session.NewCoordinator(ctx, store, registry, engine, broker, container, logger, waLogger)

	if err := coord.Restore(ctx); err != nil {
		logger.Error("session restore failed", "err", err)
		os.Exit(1)
	}
	defer coord.TeardownAll()

	apiServer := api.NewServer(cfg, coord, engine, store, broker, registry, *bridgeURL)
	httpSrv := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: apiServer.Routes(),
	}

	go func() {
		logger.Info("Universal WaCalls Engine listening", "addr", cfg.ListenAddr, "env", cfg.AppEnv)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server error", "err", err)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_ = httpSrv.Shutdown(shutdownCtx)
	coord.TeardownAll()
	logger.Info("server shutdown complete")
}

func openDB(dbPath string) (*sql.DB, error) {
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

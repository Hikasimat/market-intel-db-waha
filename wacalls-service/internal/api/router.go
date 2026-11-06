package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"wacalls/internal/config"
	"wacalls/internal/events"
	"wacalls/internal/providers"
	"wacalls/internal/session"
)

// Server encapsulates the HTTP API and routing.
type Server struct {
	cfg         config.Config
	coordinator *session.Coordinator
	engine      *session.Engine
	store       *session.Store
	broker      *events.Broker
	providers   *providers.Registry
	bridgeURL   string
}

// NewServer constructs the API server.
func NewServer(cfg config.Config, coord *session.Coordinator, engine *session.Engine, store *session.Store, broker *events.Broker, reg *providers.Registry, bridgeURL string) *Server {
	return &Server{
		cfg:         cfg,
		coordinator: coord,
		engine:      engine,
		store:       store,
		broker:      broker,
		providers:   reg,
		bridgeURL:   bridgeURL,
	}
}

// Routes constructs the HTTP handler mux.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Health & readiness
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)

	// Bridge RPC routes for Baileys integration
	mux.HandleFunc("POST /api/bridge/sessions", s.handleBridgeRegister)
	mux.HandleFunc("DELETE /api/bridge/sessions/{name}", s.handleBridgeDisconnect)
	mux.HandleFunc("POST /api/bridge/sessions/{sid}/events", s.handleBridgeEvent)
	mux.HandleFunc("POST /api/bridge/sessions/{sid}/ack", s.handleBridgeAck)

	// v1 REST API: Provider Management
	mux.HandleFunc("GET /api/v1/providers", s.handleListProviders)
	mux.HandleFunc("POST /api/v1/providers", s.handleCreateProvider)
	mux.HandleFunc("GET /api/v1/providers/{id}", s.handleGetProvider)
	mux.HandleFunc("PATCH /api/v1/providers/{id}", s.handleUpdateProvider)
	mux.HandleFunc("DELETE /api/v1/providers/{id}", s.handleDeleteProvider)

	// v1 REST API: WhatsApp Sessions
	mux.HandleFunc("GET /api/v1/sessions", s.handleListSessions)
	mux.HandleFunc("POST /api/v1/sessions", s.handleCreateSession)
	mux.HandleFunc("GET /api/v1/sessions/{id}", s.handleGetSession)
	mux.HandleFunc("GET /api/v1/sessions/{id}/status", s.handleGetSessionStatus)
	mux.HandleFunc("GET /api/v1/sessions/{id}/qr", s.handleGetSessionQR)
	mux.HandleFunc("POST /api/v1/sessions/{id}/connect", s.handleConnectSession)
	mux.HandleFunc("POST /api/v1/sessions/{id}/disconnect", s.handleDisconnectSession)
	mux.HandleFunc("DELETE /api/v1/sessions/{id}", s.handleDeleteSession)

	// v1 REST API: Calling
	mux.HandleFunc("POST /api/v1/sessions/{id}/calls", s.handleStartCall)
	mux.HandleFunc("GET /api/v1/sessions/{id}/calls", s.handleListCalls)
	mux.HandleFunc("GET /api/v1/calls/{call_id}", s.handleGetCall)
	mux.HandleFunc("POST /api/v1/calls/{call_id}/accept", s.handleAcceptCall)
	mux.HandleFunc("POST /api/v1/calls/{call_id}/reject", s.handleRejectCall)
	mux.HandleFunc("POST /api/v1/calls/{call_id}/hangup", s.handleHangupCall)
	mux.HandleFunc("POST /api/v1/calls/{call_id}/webrtc", s.handleWebRTC)

	// v1 REST API: Events & History
	mux.HandleFunc("GET /api/v1/events", s.handleEvents)
	mux.HandleFunc("GET /api/v1/sessions/{id}/history", s.handleHistory)

	// Backward-compatible routes for original WaCalls UI
	mux.HandleFunc("GET /api/sessions", s.handleListSessions)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.handleDeleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/logout", s.handleDisconnectSession)
	mux.HandleFunc("POST /api/sessions/{id}/pair", s.handleConnectSession)
	mux.HandleFunc("POST /api/sessions/{id}/calls", s.handleStartCall)
	mux.HandleFunc("POST /api/sessions/{id}/calls/{call_id}/webrtc", s.handleWebRTC)
	mux.HandleFunc("POST /api/sessions/{id}/calls/{call_id}/accept", s.handleAcceptCall)
	mux.HandleFunc("POST /api/sessions/{id}/calls/{call_id}/reject", s.handleRejectCall)
	mux.HandleFunc("DELETE /api/sessions/{id}/calls/{call_id}", s.handleHangupCall)
	mux.HandleFunc("GET /api/sessions/{id}/history", s.handleHistory)
	mux.HandleFunc("GET /api/events", s.handleEvents)

	// Static client file server
	if s.cfg.StaticDir != "" {
		if _, err := os.Stat(s.cfg.StaticDir); err == nil {
			mux.Handle("/", http.FileServer(http.Dir(s.cfg.StaticDir)))
		}
	}

	// Apply Middlewares: CORS, Tenant & Auth
	handler := s.withAuth(mux)
	handler = s.withCORS(handler)
	return handler
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Client-Id, X-Tenant-Id")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bypass auth for health, SSE, and static files
		if r.URL.Path == "/health" || r.URL.Path == "/ready" || r.URL.Path == "/api/events" || r.URL.Path == "/api/v1/events" || !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		if s.cfg.APIKey != "" {
			apiKey := r.Header.Get("X-Api-Key")
			if apiKey == "" {
				authHeader := r.Header.Get("Authorization")
				if strings.HasPrefix(authHeader, "Bearer ") {
					apiKey = strings.TrimPrefix(authHeader, "Bearer ")
				}
			}
			if apiKey != s.cfg.APIKey {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid api key"})
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func tenantID(r *http.Request) string {
	if t := r.Header.Get("X-Tenant-Id"); t != "" {
		return strings.TrimSpace(t)
	}
	if t := r.URL.Query().Get("tenantId"); t != "" {
		return strings.TrimSpace(t)
	}
	return "default"
}

func clientID(r *http.Request) string {
	if id := r.Header.Get("X-Client-Id"); id != "" {
		return strings.TrimSpace(id)
	}
	if id := r.URL.Query().Get("clientId"); id != "" {
		return strings.TrimSpace(id)
	}
	return "anonymous"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

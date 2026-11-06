package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"wacalls/internal/core"
	"wacalls/internal/providers/bridge"
	"wacalls/internal/session"

	"go.mau.fi/whatsmeow/types"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"app_env": s.cfg.AppEnv,
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ready",
		"active_calls": s.engine.ActiveCallCount(),
	})
}

// Provider Handlers

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	tID := tenantID(r)
	list, err := s.store.ListProviders(r.Context(), tID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": list})
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	var body core.ProviderConfig
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json payload"})
		return
	}
	if body.ID == "" {
		body.ID = session.GenerateID()
	}
	body.TenantID = tenantID(r)
	if body.Type == "" {
		body.Type = "native"
	}

	if err := s.store.SaveProvider(r.Context(), body); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, body)
}

func (s *Server) handleGetProvider(w http.ResponseWriter, r *http.Request) {
	pID := r.PathValue("id")
	p, err := s.store.GetProvider(r.Context(), tenantID(r), pID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "provider not found"})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	pID := r.PathValue("id")
	tID := tenantID(r)
	existing, err := s.store.GetProvider(r.Context(), tID, pID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "provider not found"})
		return
	}

	var update struct {
		Name     *string        `json:"name"`
		Settings map[string]any `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json payload"})
		return
	}
	if update.Name != nil {
		existing.Name = *update.Name
	}
	if update.Settings != nil {
		existing.Settings = update.Settings
	}

	if err := s.store.SaveProvider(r.Context(), *existing); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, existing)
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	pID := r.PathValue("id")
	if err := s.store.DeleteProvider(r.Context(), tenantID(r), pID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Session Handlers

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := s.coordinator.ListSessions(tenantID(r))
	// Maintain backward compatibility with UI expecting SessionInfo format
	out := make([]map[string]any, 0, len(sessions))
	for _, st := range sessions {
		out = append(out, map[string]any{
			"id":       st.SessionID,
			"name":     st.Name,
			"jid":      st.JID,
			"state":    st.State,
			"paired":   st.Paired,
			"can_call": st.CanCall,
			"provider": st.Provider,
			"reason":   st.Reason,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string         `json:"name"`
		ProviderType string         `json:"provider_type"`
		Settings     map[string]any `json:"settings"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	provType := body.ProviderType
	if provType == "" {
		provType = s.cfg.DefaultProvider
	}

	id, err := s.coordinator.Create(r.Context(), tenantID(r), body.Name, provType, body.Settings)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	st, err := s.coordinator.GetSessionStatus(r.Context(), tenantID(r), sID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGetSessionStatus(w http.ResponseWriter, r *http.Request) {
	s.handleGetSession(w, r)
}

func (s *Server) handleGetSessionQR(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	qr, err := s.coordinator.GetQRCode(r.Context(), tenantID(r), sID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, qr)
}

func (s *Server) handleConnectSession(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	if err := s.coordinator.Pair(r.Context(), tenantID(r), sID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDisconnectSession(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	if err := s.coordinator.Logout(r.Context(), tenantID(r), sID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	if err := s.coordinator.Delete(r.Context(), tenantID(r), sID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Calling Handlers

func (s *Server) handleStartCall(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	if sID == "" {
		sID = r.PathValue("sid")
	}

	var req core.CallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Phone) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "phone number required"})
		return
	}

	callID, err := s.engine.StartCall(r.Context(), tenantID(r), sID, req, clientID(r))
	if err != nil {
		switch err {
		case core.ErrVoipUnsupported:
			writeJSON(w, http.StatusNotImplemented, map[string]string{
				"error":   "calling_unsupported",
				"message": "Selected WhatsApp provider does not support WhatsApp VoIP protocol calling.",
			})
		case core.ErrSessionNotPaired:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session not paired"})
		case core.ErrOperatorBusy:
			writeJSON(w, http.StatusConflict, map[string]string{"error": "operator already on a call"})
		case core.ErrMaxConcurrentCalls:
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "max concurrent calls reached"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"call": map[string]string{"callId": callID},
	})
}

func (s *Server) handleListCalls(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	calls := s.engine.ListCalls(tenantID(r), sID)
	writeJSON(w, http.StatusOK, map[string]any{"calls": calls})
}

func (s *Server) handleGetCall(w http.ResponseWriter, r *http.Request) {
	cID := r.PathValue("call_id")
	rec, ok := s.engine.GetCall(tenantID(r), cID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "call not found"})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func callAndSessionIDs(r *http.Request) (string, string) {
	cID := r.PathValue("call_id")
	sID := r.PathValue("sid")
	if sID == "" {
		sID = r.PathValue("id")
	}
	if cID == "" && r.PathValue("sid") != "" {
		cID = r.PathValue("id")
	}
	return sID, cID
}

func (s *Server) handleAcceptCall(w http.ResponseWriter, r *http.Request) {
	sID, cID := callAndSessionIDs(r)

	if err := s.engine.AcceptCall(r.Context(), tenantID(r), sID, cID, clientID(r)); err != nil {
		switch err {
		case core.ErrOperatorBusy:
			writeJSON(w, http.StatusConflict, map[string]string{"error": "operator already on a call"})
		case core.ErrCallClaimed:
			writeJSON(w, http.StatusConflict, map[string]string{"error": "claimed by another operator"})
		case core.ErrCallNotFound:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "call not found"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"call": map[string]string{"callId": cID}})
}

func (s *Server) handleRejectCall(w http.ResponseWriter, r *http.Request) {
	sID, cID := callAndSessionIDs(r)

	_ = s.engine.RejectCall(r.Context(), tenantID(r), sID, cID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleHangupCall(w http.ResponseWriter, r *http.Request) {
	sID, cID := callAndSessionIDs(r)

	_ = s.engine.EndCall(r.Context(), tenantID(r), sID, cID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleWebRTC(w http.ResponseWriter, r *http.Request) {
	sID, cID := callAndSessionIDs(r)

	var body struct {
		SDPOffer string `json:"sdp_offer"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SDPOffer == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sdp_offer required"})
		return
	}

	answer, err := s.engine.HandleWebRTC(r.Context(), tenantID(r), sID, cID, body.SDPOffer)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sdp_answer": answer})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("id")
	if sID == "" {
		sID = r.PathValue("sid")
	}
	history := s.engine.History(tenantID(r), sID, 50)
	writeJSON(w, http.StatusOK, map[string]any{"rows": history})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	s.broker.ServeSSE(w, r, tenantID(r), clientID(r))
}

type bridgeSessionPayload struct {
	Name           string `json:"name"`
	JID            string `json:"jid"`
	LID            string `json:"lid"`
	DeviceIdentity string `json:"deviceIdentity"`
	Token          string `json:"token"`
}

func (s *Server) handleBridgeRegister(w http.ResponseWriter, r *http.Request) {
	var body bridgeSessionPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
		return
	}
	tID := tenantID(r)
	if tID == "" {
		tID = "default"
	}
	name := body.Name
	if name == "" {
		name = "default"
	}
	sID := name

	token := body.Token
	if token == "" {
		token = s.cfg.APIKey
	}

	jid, _ := types.ParseJID(body.JID)
	lid, _ := types.ParseJID(body.LID)
	devIdent, _ := base64.StdEncoding.DecodeString(body.DeviceIdentity)

	existingProv, ok := s.providers.Get(tID, sID)
	if ok {
		if bp, ok := existingProv.(*bridge.BridgeProvider); ok {
			bp.SetIdentity(jid, lid, devIdent, token)
			_ = bp.Connect(r.Context())
			writeJSON(w, http.StatusOK, map[string]string{"id": sID})
			return
		}
	}

	bp := bridge.NewBridgeProvider(bridge.Config{
		ID:             sID,
		TenantID:       tID,
		Name:           name,
		JID:            jid,
		LID:            lid,
		DeviceIdentity: devIdent,
		BridgeURL:      s.bridgeURL,
		InternalToken:  token,
	})
	s.providers.Register(bp)
	s.engine.AttachProvider(bp)

	_ = s.store.SaveSession(r.Context(), session.SessionRecord{
		ID:         sID,
		TenantID:   tID,
		ProviderID: sID,
		Name:       name,
		JID:        body.JID,
		CreatedAt:  time.Now().UnixMilli(),
	})

	writeJSON(w, http.StatusOK, map[string]string{"id": sID})
}

func (s *Server) handleBridgeDisconnect(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("name")
	tID := tenantID(r)
	if existingProv, ok := s.providers.Get(tID, sID); ok {
		_ = existingProv.Disconnect(r.Context())
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBridgeEvent(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("sid")
	tID := tenantID(r)
	prov, ok := s.providers.Get(tID, sID)
	if !ok {
		altID := strings.TrimPrefix(sID, "calling_")
		if altID == sID {
			altID = "calling_" + sID
		}
		prov, ok = s.providers.Get(tID, altID)
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	bp, isBridge := prov.(*bridge.BridgeProvider)
	if !isBridge {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a bridge provider"})
		return
	}

	var body struct {
		Type string          `json:"type"`
		From string          `json:"from"`
		ID   string          `json:"id"`
		Data bridge.JsonNode `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
		return
	}
	from, _ := types.ParseJID(body.From)
	node := bridge.DecodeNode(body.Data)
	w.WriteHeader(http.StatusNoContent)

	go func() {
		ctx := context.Background()
		switch body.Type {
		case "offer":
			if bp.OnIncomingOffer != nil {
				bp.OnIncomingOffer(ctx, from, &node)
			}
		case "accept":
			if bp.OnIncomingAccept != nil {
				bp.OnIncomingAccept(ctx, from, &node)
			}
		case "transport":
			if bp.OnIncomingTransport != nil {
				bp.OnIncomingTransport(ctx, from, &node)
			}
		case "terminate", "reject":
			if bp.OnIncomingTerminate != nil {
				bp.OnIncomingTerminate(ctx, from, &node)
			}
		}
	}()
}

func (s *Server) handleBridgeAck(w http.ResponseWriter, r *http.Request) {
	sID := r.PathValue("sid")
	tID := tenantID(r)
	prov, ok := s.providers.Get(tID, sID)
	if !ok {
		altID := strings.TrimPrefix(sID, "calling_")
		if altID == sID {
			altID = "calling_" + sID
		}
		prov, ok = s.providers.Get(tID, altID)
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	bp, isBridge := prov.(*bridge.BridgeProvider)
	if !isBridge {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a bridge provider"})
		return
	}

	var body struct {
		Type string          `json:"type"`
		From string          `json:"from"`
		ID   string          `json:"id"`
		Data bridge.JsonNode `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
		return
	}
	node := bridge.DecodeNode(body.Data)
	w.WriteHeader(http.StatusNoContent)

	go func() {
		ctx := context.Background()
		if bp.OnIncomingAck != nil {
			bp.OnIncomingAck(ctx, &node)
		}
	}()
}


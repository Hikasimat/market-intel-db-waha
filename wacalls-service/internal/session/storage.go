package session

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"time"

	"wacalls/internal/core"
)

// Store handles persistent storage for sessions, providers, and call records with tenant isolation.
type Store struct {
	db *sql.DB
}

// NewStore initializes database schema for multi-tenant sessions and providers.
func NewStore(ctx context.Context, db *sql.DB) (*Store, error) {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS providers (
			id TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			type TEXT NOT NULL,
			name TEXT NOT NULL,
			settings TEXT,
			is_default INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			name TEXT NOT NULL,
			jid TEXT,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS call_history (
			call_id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			direction TEXT NOT NULL,
			peer TEXT NOT NULL,
			owner TEXT,
			started_at INTEGER NOT NULL,
			ended_at INTEGER,
			duration_ms INTEGER,
			status TEXT NOT NULL,
			end_reason TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)`,
		`CREATE INDEX IF NOT EXISTS idx_call_history_tenant ON call_history(tenant_id, session_id)`,
	}

	for _, q := range queries {
		if _, err := db.ExecContext(ctx, q); err != nil {
			return nil, err
		}
	}

	return &Store{db: db}, nil
}

// GenerateID produces a random 16-byte hex string.
func GenerateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Providers

func (s *Store) SaveProvider(ctx context.Context, p core.ProviderConfig) error {
	settingsJSON, _ := json.Marshal(p.Settings)
	isDef := 0
	if p.IsDefault {
		isDef = 1
	}
	now := time.Now().UnixMilli()
	if p.CreatedAt == 0 {
		p.CreatedAt = now
	}
	p.UpdatedAt = now

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO providers (id, tenant_id, type, name, settings, is_default, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(tenant_id, id) DO UPDATE SET
			type = excluded.type,
			name = excluded.name,
			settings = excluded.settings,
			is_default = excluded.is_default,
			updated_at = excluded.updated_at
	`, p.ID, p.TenantID, p.Type, p.Name, string(settingsJSON), isDef, p.CreatedAt, p.UpdatedAt)
	return err
}

func (s *Store) GetProvider(ctx context.Context, tenantID, id string) (*core.ProviderConfig, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, tenant_id, type, name, COALESCE(settings, '{}'), is_default, created_at, updated_at
		FROM providers WHERE tenant_id = ? AND id = ?
	`, tenantID, id)

	var p core.ProviderConfig
	var settingsStr string
	var isDef int
	if err := row.Scan(&p.ID, &p.TenantID, &p.Type, &p.Name, &settingsStr, &isDef, &p.CreatedAt, &p.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, core.ErrNotFound
		}
		return nil, err
	}
	p.IsDefault = (isDef == 1)
	_ = json.Unmarshal([]byte(settingsStr), &p.Settings)
	return &p, nil
}

func (s *Store) ListProviders(ctx context.Context, tenantID string) ([]core.ProviderConfig, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, tenant_id, type, name, COALESCE(settings, '{}'), is_default, created_at, updated_at
		FROM providers WHERE tenant_id = ? ORDER BY created_at
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []core.ProviderConfig
	for rows.Next() {
		var p core.ProviderConfig
		var settingsStr string
		var isDef int
		if err := rows.Scan(&p.ID, &p.TenantID, &p.Type, &p.Name, &settingsStr, &isDef, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.IsDefault = (isDef == 1)
		_ = json.Unmarshal([]byte(settingsStr), &p.Settings)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) DeleteProvider(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM providers WHERE tenant_id = ? AND id = ?`, tenantID, id)
	return err
}

// Sessions

type SessionRecord struct {
	ID         string `json:"id"`
	TenantID   string `json:"tenant_id"`
	ProviderID string `json:"provider_id"`
	Name       string `json:"name"`
	JID        string `json:"jid"`
	CreatedAt  int64  `json:"created_at"`
}

func (s *Store) SaveSession(ctx context.Context, rec SessionRecord) error {
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().UnixMilli()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (id, tenant_id, provider_id, name, jid, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(tenant_id, id) DO UPDATE SET
			provider_id = excluded.provider_id,
			name = excluded.name,
			jid = excluded.jid
	`, rec.ID, rec.TenantID, rec.ProviderID, rec.Name, rec.JID, rec.CreatedAt)
	return err
}

func (s *Store) SetSessionJID(ctx context.Context, tenantID, id, jid string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET jid = ? WHERE tenant_id = ? AND id = ?`, jid, tenantID, id)
	return err
}

func (s *Store) GetSession(ctx context.Context, tenantID, id string) (*SessionRecord, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, tenant_id, provider_id, name, COALESCE(jid, ''), created_at
		FROM sessions WHERE tenant_id = ? AND id = ?
	`, tenantID, id)
	var rec SessionRecord
	if err := row.Scan(&rec.ID, &rec.TenantID, &rec.ProviderID, &rec.Name, &rec.JID, &rec.CreatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, core.ErrNotFound
		}
		return nil, err
	}
	return &rec, nil
}

func (s *Store) ListSessions(ctx context.Context, tenantID string) ([]SessionRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, tenant_id, provider_id, name, COALESCE(jid, ''), created_at
		FROM sessions WHERE tenant_id = ? ORDER BY created_at
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionRecord
	for rows.Next() {
		var rec SessionRecord
		if err := rows.Scan(&rec.ID, &rec.TenantID, &rec.ProviderID, &rec.Name, &rec.JID, &rec.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) ListAllSessions(ctx context.Context) ([]SessionRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, tenant_id, provider_id, name, COALESCE(jid, ''), created_at
		FROM sessions ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionRecord
	for rows.Next() {
		var rec SessionRecord
		if err := rows.Scan(&rec.ID, &rec.TenantID, &rec.ProviderID, &rec.Name, &rec.JID, &rec.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSession(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE tenant_id = ? AND id = ?`, tenantID, id)
	return err
}

// Call History

func (s *Store) UpsertCall(ctx context.Context, r core.CallRecord) error {
	var ownerVal *string
	if r.Owner != nil && *r.Owner != "" {
		ownerVal = r.Owner
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO call_history (call_id, tenant_id, session_id, direction, peer, owner, started_at, ended_at, duration_ms, status, end_reason)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(call_id) DO UPDATE SET
			owner = COALESCE(excluded.owner, call_history.owner),
			ended_at = excluded.ended_at,
			duration_ms = excluded.duration_ms,
			status = excluded.status,
			end_reason = excluded.end_reason
	`, r.CallID, r.TenantID, r.SessionID, r.Direction, r.Peer, ownerVal, r.StartedAt, r.EndedAt, r.DurationMs, r.Status, r.EndReason)
	return err
}

func (s *Store) GetCall(ctx context.Context, tenantID, callID string) (*core.CallRecord, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT call_id, tenant_id, session_id, direction, peer, owner, started_at, COALESCE(ended_at, 0), COALESCE(duration_ms, 0), status, COALESCE(end_reason, '')
		FROM call_history WHERE tenant_id = ? AND call_id = ?
	`, tenantID, callID)

	var r core.CallRecord
	var owner sql.NullString
	if err := row.Scan(&r.CallID, &r.TenantID, &r.SessionID, &r.Direction, &r.Peer, &owner, &r.StartedAt, &r.EndedAt, &r.DurationMs, &r.Status, &r.EndReason); err != nil {
		if err == sql.ErrNoRows {
			return nil, core.ErrCallNotFound
		}
		return nil, err
	}
	if owner.Valid {
		r.Owner = &owner.String
	}
	return &r, nil
}

func (s *Store) History(ctx context.Context, tenantID, sessionID string, limit int) ([]core.CallRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	query := `
		SELECT call_id, tenant_id, session_id, direction, peer, owner, started_at, COALESCE(ended_at, 0), COALESCE(duration_ms, 0), status, COALESCE(end_reason, '')
		FROM call_history WHERE tenant_id = ?
	`
	args := []any{tenantID}
	if sessionID != "" {
		query += " AND session_id = ?"
		args = append(args, sessionID)
	}
	query += " ORDER BY started_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []core.CallRecord
	for rows.Next() {
		var r core.CallRecord
		var owner sql.NullString
		if err := rows.Scan(&r.CallID, &r.TenantID, &r.SessionID, &r.Direction, &r.Peer, &owner, &r.StartedAt, &r.EndedAt, &r.DurationMs, &r.Status, &r.EndReason); err != nil {
			return nil, err
		}
		if owner.Valid {
			r.Owner = &owner.String
		}
		out = append(out, r)
	}
	return out, rows.Err()
}


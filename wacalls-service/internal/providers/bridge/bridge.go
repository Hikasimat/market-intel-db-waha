package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"wacalls/internal/core"
	voipCore "wacalls/internal/voip/core"
	"wacalls/internal/voip/signaling"
	"wacalls/internal/voip/wanode"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

// Config defines settings for BridgeProvider.
type Config struct {
	ID             string
	TenantID       string
	Name           string
	JID            types.JID
	LID            types.JID
	DeviceIdentity []byte
	BridgeURL      string
	InternalToken  string
	Log            *slog.Logger
}

// BridgeProvider implements core.WhatsAppProvider backed by a Baileys session in Node.js.
// It has no WhatsApp login of its own; it reuses the authenticated Baileys socket.
type BridgeProvider struct {
	cfg    Config
	rpc    *rpcClient
	socket *bridgeSocket
	log    *slog.Logger

	mu     sync.RWMutex
	state  string // "open", "logged_out"
	paired bool

	subs  []chan core.Event
	subMu sync.Mutex

	OnIncomingOffer     func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingAccept    func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingTransport func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingTerminate func(ctx context.Context, from types.JID, node *waBinary.Node)
	OnIncomingAck       func(ctx context.Context, node *waBinary.Node)
}

func NewBridgeProvider(cfg Config) *BridgeProvider {
	if cfg.TenantID == "" {
		cfg.TenantID = "default"
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	rpc := newRPCClient(cfg.BridgeURL, cfg.InternalToken)
	bs := &bridgeSocket{
		name:        cfg.Name,
		ownPN:       cfg.JID,
		ownLID:      cfg.LID,
		devIdentity: cfg.DeviceIdentity,
		rpc:         rpc,
	}
	return &BridgeProvider{
		cfg:    cfg,
		rpc:    rpc,
		socket: bs,
		log:    cfg.Log.With("provider", "bridge", "session", cfg.ID),
		state:  "open",
		paired: true,
	}
}

func (p *BridgeProvider) ID() string       { return p.cfg.ID }
func (p *BridgeProvider) TenantID() string { return p.cfg.TenantID }
func (p *BridgeProvider) Type() string     { return "bridge" }
func (p *BridgeProvider) Name() string     { return p.cfg.Name }

func (p *BridgeProvider) SetIdentity(jid, lid types.JID, devIdentity []byte, token ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cfg.JID = jid
	p.cfg.LID = lid
	p.cfg.DeviceIdentity = devIdentity
	if len(token) > 0 && token[0] != "" {
		p.cfg.InternalToken = token[0]
		p.rpc.token = token[0]
	}
	p.socket.ownPN = jid
	p.socket.ownLID = lid
	p.socket.devIdentity = devIdentity
}

func (p *BridgeProvider) SetCallHandlers(
	onOffer func(ctx context.Context, from types.JID, node *waBinary.Node),
	onAccept func(ctx context.Context, from types.JID, node *waBinary.Node),
	onTransport func(ctx context.Context, from types.JID, node *waBinary.Node),
	onTerminate func(ctx context.Context, from types.JID, node *waBinary.Node),
	onAck func(ctx context.Context, node *waBinary.Node),
) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.OnIncomingOffer = onOffer
	p.OnIncomingAccept = onAccept
	p.OnIncomingTransport = onTransport
	p.OnIncomingTerminate = onTerminate
	p.OnIncomingAck = onAck
}

func (p *BridgeProvider) GetCapabilities() core.ProviderCapabilities {
	return core.ProviderCapabilities{
		HasNativeAuth:              false,
		HasExternalQROwner:         true,
		SupportsSessionReuse:       true,
		SupportsVoIPSignaling:      true,
		SupportsIncomingCalls:      true,
		SupportsOutgoingCalls:      true,
		SupportsCallAcceptance:     true,
		SupportsCallRejection:      true,
		SupportsCallTermination:    true,
		SupportsBidirectionalAudio: true,
		SupportsCallEvents:         true,
		SupportsConcurrentCalls:    true,
		MaxConcurrentCalls:         8,
	}
}

func (p *BridgeProvider) Connect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "open"
	p.paired = true
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "open", "paired": true})
	return nil
}

func (p *BridgeProvider) Disconnect(ctx context.Context) error {
	p.mu.Lock()
	p.state = "logged_out"
	p.paired = false
	p.mu.Unlock()
	p.emitEvent(core.EventAuthState, map[string]any{"state": "logged_out", "paired": false})
	return nil
}

func (p *BridgeProvider) GetSessionStatus(ctx context.Context) (core.SessionStatus, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	jidStr := ""
	if !p.cfg.JID.IsEmpty() {
		jidStr = p.cfg.JID.String()
	}

	return core.SessionStatus{
		ID:        p.cfg.ID,
		SessionID: p.cfg.ID,
		TenantID:  p.cfg.TenantID,
		Name:      p.cfg.Name,
		Provider:  "bridge",
		State:     p.state,
		Paired:    p.paired,
		JID:       jidStr,
		Phone:     wanode.CleanJID(jidStr),
		CanCall:   p.paired && p.state == "open",
		UpdatedAt: time.Now().UnixMilli(),
	}, nil
}

func (p *BridgeProvider) GetQRCode(ctx context.Context) (core.QRCode, error) {
	return core.QRCode{}, fmt.Errorf("calling session reuses the existing WhatsApp QR session")
}

func (p *BridgeProvider) Pair(ctx context.Context) error {
	return nil
}

func (p *BridgeProvider) Logout(ctx context.Context) error {
	return p.Disconnect(ctx)
}

func (p *BridgeProvider) GetVoipSocket() (voipCore.VoipSocket, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.socket == nil {
		return nil, core.ErrVoipUnsupported
	}
	return p.socket, nil
}

func (p *BridgeProvider) SubscribeEvents(ctx context.Context) (<-chan core.Event, error) {
	ch := make(chan core.Event, 32)
	p.subMu.Lock()
	p.subs = append(p.subs, ch)
	p.subMu.Unlock()

	go func() {
		<-ctx.Done()
		p.subMu.Lock()
		for i, c := range p.subs {
			if c == ch {
				p.subs = append(p.subs[:i], p.subs[i+1:]...)
				close(ch)
				break
			}
		}
		p.subMu.Unlock()
	}()
	return ch, nil
}

func (p *BridgeProvider) Close() error {
	p.subMu.Lock()
	for _, ch := range p.subs {
		close(ch)
	}
	p.subs = nil
	p.subMu.Unlock()
	return nil
}

func (p *BridgeProvider) emitEvent(evtType core.EventType, payload map[string]any) {
	evt := core.NewEvent(evtType, p.cfg.ID, "", p.cfg.TenantID, payload)
	p.subMu.Lock()
	defer p.subMu.Unlock()
	for _, ch := range p.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

// rpcClient calls back into the Node.js (Baileys) host process.
type rpcClient struct {
	baseURL string
	token   string
	hc      *http.Client
}

func newRPCClient(baseURL, token string) *rpcClient {
	return &rpcClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		hc:      &http.Client{Timeout: 70 * time.Second},
	}
}

func (c *rpcClient) call(ctx context.Context, session, method string, params any, out any) error {
	body, err := json.Marshal(map[string]any{"session": session, "method": method, "params": params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/bridge/rpc", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("X-Internal-Token", c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(raw))
		}
		return fmt.Errorf("bridge rpc %s failed (HTTP %d): %s", method, resp.StatusCode, e.Error)
	}
	if out == nil {
		return nil
	}
	var env struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if len(env.Result) == 0 || string(env.Result) == "null" {
		return nil
	}
	return json.Unmarshal(env.Result, out)
}

// JsonNode is the wire format of a binary node exchanged with Node.js.
type JsonNode struct {
	Tag     string            `json:"tag"`
	Attrs   map[string]string `json:"attrs"`
	Content json.RawMessage   `json:"content,omitempty"`
}

func EncodeNode(n waBinary.Node) JsonNode {
	out := JsonNode{Tag: n.Tag, Attrs: map[string]string{}}
	for k, v := range n.Attrs {
		switch t := v.(type) {
		case string:
			out.Attrs[k] = t
		case types.JID:
			out.Attrs[k] = t.String()
		case nil:
		default:
			out.Attrs[k] = fmt.Sprint(t)
		}
	}
	switch c := n.Content.(type) {
	case nil:
	case string:
		out.Content, _ = json.Marshal(c)
	case []byte:
		out.Content, _ = json.Marshal(map[string]string{"$b": base64.StdEncoding.EncodeToString(c)})
	case []waBinary.Node:
		children := make([]JsonNode, 0, len(c))
		for _, ch := range c {
			children = append(children, EncodeNode(ch))
		}
		out.Content, _ = json.Marshal(children)
	}
	return out
}

func DecodeNode(j JsonNode) waBinary.Node {
	attrs := waBinary.Attrs{}
	for k, v := range j.Attrs {
		if strings.Contains(v, "@") {
			if jid, err := types.ParseJID(v); err == nil {
				attrs[k] = jid
				continue
			}
		}
		attrs[k] = v
	}
	n := waBinary.Node{Tag: j.Tag, Attrs: attrs}
	raw := bytes.TrimSpace(j.Content)
	if len(raw) == 0 || string(raw) == "null" {
		return n
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			n.Content = s
		}
	case '{':
		var b struct {
			B string `json:"$b"`
		}
		if json.Unmarshal(raw, &b) == nil {
			if data, err := base64.StdEncoding.DecodeString(b.B); err == nil {
				n.Content = data
			}
		}
	case '[':
		var kids []JsonNode
		if json.Unmarshal(raw, &kids) == nil {
			nodes := make([]waBinary.Node, 0, len(kids))
			for _, k := range kids {
				nodes = append(nodes, DecodeNode(k))
			}
			n.Content = nodes
		}
	}
	return n
}

// bridgeSocket implements core.VoipSocket on top of the Baileys socket.
type bridgeSocket struct {
	name        string
	ownPN       types.JID
	ownLID      types.JID
	devIdentity []byte
	rpc         *rpcClient
}

var _ voipCore.VoipSocket = (*bridgeSocket)(nil)

func (s *bridgeSocket) OwnPN() types.JID  { return s.ownPN }
func (s *bridgeSocket) OwnLID() types.JID { return s.ownLID }

func (s *bridgeSocket) AccountDeviceIdentityNode() (waBinary.Node, bool) {
	if len(s.devIdentity) == 0 {
		return waBinary.Node{}, false
	}
	return waBinary.Node{Tag: "device-identity", Attrs: waBinary.Attrs{}, Content: s.devIdentity}, true
}

func (s *bridgeSocket) SendNode(ctx context.Context, node waBinary.Node) error {
	return s.rpc.call(ctx, s.name, "sendNode", map[string]any{"node": EncodeNode(node)}, nil)
}

func (s *bridgeSocket) Query(ctx context.Context, node waBinary.Node) (*waBinary.Node, error) {
	var res struct {
		Node *JsonNode `json:"node"`
	}
	if err := s.rpc.call(ctx, s.name, "query", map[string]any{"node": EncodeNode(node)}, &res); err != nil {
		return nil, err
	}
	if res.Node == nil {
		return nil, nil
	}
	n := DecodeNode(*res.Node)
	return &n, nil
}

func (s *bridgeSocket) GetUSyncDevices(ctx context.Context, jids []types.JID) ([]types.JID, error) {
	in := make([]string, 0, len(jids))
	for _, j := range jids {
		in = append(in, j.ToNonAD().String())
	}
	var res struct {
		JIDs []string `json:"jids"`
	}
	if err := s.rpc.call(ctx, s.name, "getUSyncDevices", map[string]any{"jids": in}, &res); err != nil {
		return nil, err
	}
	out := make([]types.JID, 0, len(res.JIDs))
	for _, raw := range res.JIDs {
		if jid, err := types.ParseJID(raw); err == nil {
			out = append(out, jid)
		}
	}
	return out, nil
}

func (s *bridgeSocket) AssertSessions(ctx context.Context, jids []types.JID, force bool) error {
	in := make([]string, 0, len(jids))
	for _, j := range jids {
		in = append(in, j.String())
	}
	return s.rpc.call(ctx, s.name, "assertSessions", map[string]any{"jids": in, "force": force}, nil)
}

func (s *bridgeSocket) CreateParticipantNodes(ctx context.Context, devices []types.JID, callKey []byte, encAttrs waBinary.Attrs) ([]waBinary.Node, bool, error) {
	in := make([]string, 0, len(devices))
	for _, j := range devices {
		in = append(in, j.String())
	}
	attrs := map[string]string{}
	for k, v := range encAttrs {
		switch t := v.(type) {
		case string:
			attrs[k] = t
		case types.JID:
			attrs[k] = t.String()
		default:
			attrs[k] = fmt.Sprint(t)
		}
	}
	var res struct {
		Nodes           []JsonNode `json:"nodes"`
		IncludeIdentity bool       `json:"includeIdentity"`
	}
	err := s.rpc.call(ctx, s.name, "createParticipantNodes", map[string]any{
		"devices":  in,
		"callKey":  base64.StdEncoding.EncodeToString(callKey),
		"encAttrs": attrs,
	}, &res)
	if err != nil {
		return nil, false, err
	}
	nodes := make([]waBinary.Node, 0, len(res.Nodes))
	for _, n := range res.Nodes {
		nodes = append(nodes, DecodeNode(n))
	}
	return nodes, res.IncludeIdentity, nil
}

func (s *bridgeSocket) DecryptCallKey(ctx context.Context, from types.JID, encChild *waBinary.Node) ([]byte, error) {
	if encChild == nil {
		return nil, errors.New("missing enc node")
	}
	typ, _ := encChild.Attrs["type"].(string)
	ct, _ := encChild.Content.([]byte)
	if len(ct) == 0 {
		return nil, errors.New("enc node has no ciphertext")
	}
	var res struct {
		Plaintext string `json:"plaintext"`
	}
	err := s.rpc.call(ctx, s.name, "decryptCallKey", map[string]any{
		"from":       from.String(),
		"type":       typ,
		"ciphertext": base64.StdEncoding.EncodeToString(ct),
	}, &res)
	if err != nil {
		return nil, err
	}
	plaintext, err := base64.StdEncoding.DecodeString(res.Plaintext)
	if err != nil {
		return nil, err
	}
	return signaling.DecodeCallKeyPlaintext(plaintext)
}

func (s *bridgeSocket) GetTCToken(ctx context.Context, jid types.JID) ([]byte, error) {
	var res struct {
		Token string `json:"token"`
	}
	target := jid.ToNonAD().String()
	_ = s.rpc.call(ctx, s.name, "getTCToken", map[string]any{"jid": target}, &res)
	if res.Token != "" {
		if data, err := base64.StdEncoding.DecodeString(res.Token); err == nil && len(data) > 0 {
			return data, nil
		}
	}
	return nil, nil
}

func (s *bridgeSocket) ResolveLIDForPN(ctx context.Context, pn types.JID) types.JID {
	if pn.Server == types.HiddenUserServer {
		return pn
	}
	var res struct {
		LID string `json:"lid"`
	}
	_ = s.rpc.call(ctx, s.name, "resolveLID", map[string]any{"pn": pn.User}, &res)
	if res.LID != "" {
		if lid, err := types.ParseJID(res.LID); err == nil && !lid.IsEmpty() {
			return lid.ToNonAD()
		}
	}
	return pn
}


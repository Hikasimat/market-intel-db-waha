package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"wacalls/internal/voip/core"
	"wacalls/internal/voip/signaling"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

// rpcClient calls back into the Node.js (Baileys) host process. The Go engine does
// not own a WhatsApp connection; every WhatsApp operation is executed by the
// already-authenticated Baileys socket of the matching WAHA session.
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

// jsonNode is the wire format of a binary node exchanged with Node.js.
// content is one of: null, a string, {"$b":"<base64>"} for bytes, or an array of jsonNode.
type jsonNode struct {
	Tag     string            `json:"tag"`
	Attrs   map[string]string `json:"attrs"`
	Content json.RawMessage   `json:"content,omitempty"`
}

func encodeNode(n waBinary.Node) jsonNode {
	out := jsonNode{Tag: n.Tag, Attrs: map[string]string{}}
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
		children := make([]jsonNode, 0, len(c))
		for _, ch := range c {
			children = append(children, encodeNode(ch))
		}
		out.Content, _ = json.Marshal(children)
	}
	return out
}

func decodeNode(j jsonNode) waBinary.Node {
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
		var kids []jsonNode
		if json.Unmarshal(raw, &kids) == nil {
			nodes := make([]waBinary.Node, 0, len(kids))
			for _, k := range kids {
				nodes = append(nodes, decodeNode(k))
			}
			n.Content = nodes
		}
	}
	return n
}

// bridgeSocket implements core.VoipSocket on top of the Baileys socket living in the Node host.
type bridgeSocket struct {
	name        string
	ownPN       types.JID
	ownLID      types.JID
	devIdentity []byte
	rpc         *rpcClient
}

var _ core.VoipSocket = (*bridgeSocket)(nil)

func (s *bridgeSocket) OwnPN() types.JID  { return s.ownPN }
func (s *bridgeSocket) OwnLID() types.JID { return s.ownLID }

func (s *bridgeSocket) AccountDeviceIdentityNode() (waBinary.Node, bool) {
	if len(s.devIdentity) == 0 {
		return waBinary.Node{}, false
	}
	return waBinary.Node{Tag: "device-identity", Attrs: waBinary.Attrs{}, Content: s.devIdentity}, true
}

func (s *bridgeSocket) SendNode(ctx context.Context, node waBinary.Node) error {
	return s.rpc.call(ctx, s.name, "sendNode", map[string]any{"node": encodeNode(node)}, nil)
}

func (s *bridgeSocket) Query(ctx context.Context, node waBinary.Node) (*waBinary.Node, error) {
	var res struct {
		Node *jsonNode `json:"node"`
	}
	if err := s.rpc.call(ctx, s.name, "query", map[string]any{"node": encodeNode(node)}, &res); err != nil {
		return nil, err
	}
	if res.Node == nil {
		return nil, nil
	}
	n := decodeNode(*res.Node)
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
		Nodes           []jsonNode `json:"nodes"`
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
		nodes = append(nodes, decodeNode(n))
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
	return nil, nil
}

func (s *bridgeSocket) ResolveLIDForPN(ctx context.Context, pn types.JID) types.JID {
	return pn
}


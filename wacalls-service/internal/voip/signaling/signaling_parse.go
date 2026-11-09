package signaling

import (
	"wacalls/internal/voip/core"
	"wacalls/internal/voip/wanode"

	waBinary "go.mau.fi/whatsmeow/binary"
)

type NodeInfo struct {
	Tag            string
	PeerJid        string
	CallID         string
	PeerPlatform   string
	PeerAppVersion string
	EpochID        string
	Timestamp      string
	InnerNode      *waBinary.Node
}

func ExtractNodeInfo(node *waBinary.Node) *NodeInfo {
	if node == nil {
		return nil
	}
	if node.Tag != "call" {
		callID := wanode.AttrString(node.Attrs, "call-id")
		if callID == "" {
			for _, child := range wanode.NodeChildren(node) {
				if id := wanode.AttrString(child.Attrs, "call-id"); id != "" {
					callID = id
					break
				}
			}
		}
		peerJid := wanode.AttrString(node.Attrs, "from")
		if peerJid == "" {
			peerJid = wanode.AttrString(node.Attrs, "call-creator")
		}
		return &NodeInfo{
			Tag:            node.Tag,
			PeerJid:        peerJid,
			CallID:         callID,
			PeerPlatform:   wanode.AttrString(node.Attrs, "platform"),
			PeerAppVersion: wanode.AttrString(node.Attrs, "version"),
			EpochID:        wanode.AttrString(node.Attrs, "e"),
			Timestamp:      wanode.AttrString(node.Attrs, "t"),
			InnerNode:      node,
		}
	}
	children := wanode.NodeChildren(node)
	if len(children) == 0 {
		return nil
	}
	inner := children[0]
	callID := wanode.AttrString(inner.Attrs, "call-id")
	if callID == "" {
		callID = wanode.AttrString(node.Attrs, "call-id")
	}
	peerJid := wanode.AttrString(node.Attrs, "from")
	if peerJid == "" {
		peerJid = wanode.AttrString(inner.Attrs, "from")
		if peerJid == "" {
			peerJid = wanode.AttrString(inner.Attrs, "call-creator")
		}
	}
	return &NodeInfo{
		Tag:            inner.Tag,
		PeerJid:        peerJid,
		CallID:         callID,
		PeerPlatform:   wanode.AttrString(node.Attrs, "platform"),
		PeerAppVersion: wanode.AttrString(node.Attrs, "version"),
		EpochID:        wanode.AttrString(inner.Attrs, "e"),
		Timestamp:      wanode.AttrString(inner.Attrs, "t"),
		InnerNode:      &inner,
	}
}

func ExtractRelayEndpoints(node *waBinary.Node) []core.RelayEndpoint {
	var relays []core.RelayEndpoint

	parseRelay := func(n *waBinary.Node) {
		ip := wanode.AttrString(n.Attrs, "ip")
		token := wanode.AttrString(n.Attrs, "token")
		if ip == "" || token == "" {
			return
		}
		key := wanode.AttrString(n.Attrs, "relay-key")
		if key == "" {
			key = wanode.AttrString(n.Attrs, "key")
		}
		ep := core.RelayEndpoint{
			IP:      ip,
			Port:    wanode.AttrInt(n.Attrs, "port", core.WARelayPort),
			Token:   token,
			Key:     key,
			RelayID: wanode.AttrInt(n.Attrs, "relay-id", 0),
		}
		if wanode.HasAttr(n.Attrs, "c2r-rtt") {
			v := wanode.AttrInt(n.Attrs, "c2r-rtt", 0)
			ep.C2RRtt = &v
		}
		relays = append(relays, ep)
	}

	for _, child := range wanode.NodeChildren(node) {
		child := child
		switch child.Tag {
		case "relay":
			parseRelay(&child)
		case "relays":
			for _, rn := range wanode.NodeChildren(&child) {
				rn := rn
				if rn.Tag == "relay" {
					parseRelay(&rn)
				}
			}
		}
	}

	sortRelaysByRtt(relays)
	return relays
}

func FindEncNodes(inner *waBinary.Node) []*waBinary.Node {
	var nodes []*waBinary.Node
	for _, c := range wanode.NodeChildren(inner) {
		c := c
		if c.Tag == "enc" && wanode.HasAttr(c.Attrs, "type") {
			nodes = append(nodes, &c)
		}
	}
	for _, c := range wanode.NodeChildren(inner) {
		if c.Tag != "destination" {
			continue
		}
		for _, toNode := range wanode.NodeChildren(&c) {
			if toNode.Tag != "to" {
				continue
			}
			for _, e := range wanode.NodeChildren(&toNode) {
				e := e
				if e.Tag == "enc" && wanode.HasAttr(e.Attrs, "type") {
					nodes = append(nodes, &e)
				}
			}
		}
	}
	return nodes
}

func findEncNode(inner *waBinary.Node) *waBinary.Node {
	nodes := FindEncNodes(inner)
	if len(nodes) > 0 {
		return nodes[0]
	}
	return nil
}

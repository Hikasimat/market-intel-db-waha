package main

import (
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

func wrapCall(from types.JID, id string, inner *waBinary.Node) *waBinary.Node {
	content := []waBinary.Node{}
	if inner != nil {
		content = append(content, *inner)
	}
	attrs := waBinary.Attrs{"from": from}
	if id != "" {
		attrs["id"] = id
	}
	return &waBinary.Node{
		Tag:     "call",
		Attrs:   attrs,
		Content: content,
	}
}

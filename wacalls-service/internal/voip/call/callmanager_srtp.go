package call

import (
	"wacalls/internal/voip/core"
	"wacalls/internal/voip/media"
	"wacalls/internal/voip/wanode"

	"go.mau.fi/whatsmeow/types"
)

func (m *CallManager) initSrtpKeysLocked() {
	call := m.currentCall
	if call == nil || call.EncryptionKey == nil {
		return
	}
	ourBase := wanode.CleanJID(m.ownCredJid())
	var participants []string
	if call.RelayData != nil {
		participants = call.RelayData.ParticipantJids
	}
	ourDeviceJid := ensureDeviceJid(findOurDevice(participants, ourBase, m.ownCredJid()))

	rawPeer := m.acceptedByJid
	if rawPeer == "" {
		rawPeer = call.PeerJid
		if p := firstPeerDevice(participants, ourBase); p != "" {
			rawPeer = p
		}
	}
	peerDeviceJid := ensureDeviceJid(findPeerDevice(participants, wanode.CleanJID(rawPeer), rawPeer))

	sendKM, err1 := media.DerivePerJidSrtpKey(call.EncryptionKey, ourDeviceJid)

	recvKey := call.EncryptionKey
	if len(m.peerCallKey) == 32 {
		recvKey = m.peerCallKey
	}
	recvKM, err2 := media.DerivePerJidSrtpKey(recvKey, peerDeviceJid)
	if err1 != nil || err2 != nil {
		m.log.Error("srtp key derivation failed", "err1", err1, "err2", err2)
		return
	}
	sess, err := media.NewSrtpSession(sendKM, recvKM, core.SRTPSendAuthTagLen, core.SRTPRecvAuthTagLen)
	if err != nil {
		m.log.Error("srtp session failed", "err", err)
		return
	}
	m.srtpSession = sess
	m.log.Info("srtp per-jid keys set", "send", ourDeviceJid, "recv", peerDeviceJid, "using_peer_key", len(m.peerCallKey) == 32)
}

func (m *CallManager) reinitSrtpLocked(peerKey []byte, peerJid types.JID) {
	if len(peerKey) == 32 {
		m.peerCallKey = make([]byte, 32)
		copy(m.peerCallKey, peerKey)
	}
	if peerJid.String() != "" {
		m.acceptedByJid = peerJid.String()
	}
	m.initSrtpKeysLocked()
}

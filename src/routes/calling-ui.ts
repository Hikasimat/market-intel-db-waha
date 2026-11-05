import { Router, type Request, type Response } from 'express';
import { dashboardBasicAuth } from '../middleware/basic-auth.js';
import { config } from '../config.js';
import { sessionManager } from '../manager/session-mgr.js';

export const callingUIRouter = Router();

callingUIRouter.get('/calls', dashboardBasicAuth, (req: Request, res: Response) => {
  const sessions = sessionManager.listSessions();
  const defaultSession = sessions.find((s) => s.status === 'WORKING')?.name || sessions[0]?.name || 'default';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAHA Voice Calling &bull; Live VoIP Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #0b0f17;
      --bg-surface: #111827;
      --bg-card: #182234;
      --border: #1f2d42;
      --border-light: #283952;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.25);
      --red: #ef4444;
      --red-glow: rgba(239, 68, 68, 0.25);
      --amber: #f59e0b;
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --radius: 12px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-base);
      color: var(--text);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge {
      background: #059669;
      color: #fff;
      font-weight: 700;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
    }

    .title {
      font-size: 17px;
      font-weight: 600;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-dim);
    }

    .header-links {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .btn-link {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 13px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      transition: all 0.2s;
    }

    .btn-link:hover {
      color: var(--text);
      border-color: var(--border-light);
      background: var(--bg-card);
    }

    main {
      flex: 1;
      max-width: 900px;
      width: 100%;
      margin: 32px auto;
      padding: 0 20px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
    }

    .card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    @media (max-width: 768px) {
      .grid-2 { grid-template-columns: 1fr; }
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
    }

    input, select {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }

    input:focus, select:focus {
      border-color: var(--blue);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }

    .btn-green {
      background: var(--green);
      color: #fff;
    }
    .btn-green:hover { background: #059669; }

    .btn-red {
      background: var(--red);
      color: #fff;
    }
    .btn-red:hover { background: #dc2626; }

    .btn-secondary {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: var(--border);
    }

    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 20px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .pill-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .pill-amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .pill-red { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

    /* Active Call Screen */
    #callScreen {
      display: none;
      text-align: center;
      padding: 40px 20px;
    }

    .call-avatar {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      background: linear-gradient(135deg, #10b981, #3b82f6);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      font-size: 36px;
      box-shadow: 0 0 30px var(--green-glow);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(1); box-shadow: 0 0 20px var(--green-glow); }
      50% { transform: scale(1.05); box-shadow: 0 0 40px var(--green-glow); }
      100% { transform: scale(1); box-shadow: 0 0 20px var(--green-glow); }
    }

    .call-peer {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .call-timer {
      font-size: 18px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--green);
      margin-bottom: 24px;
    }

    .call-actions {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-top: 24px;
    }

    /* Incoming Call Modal */
    #incomingModal {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      padding: 32px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }

    /* QR Pairing Modal */
    #qrModal {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .qr-container {
      background: #fff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin: 16px 0;
    }

    .qr-container img {
      display: block;
      width: 240px;
      height: 240px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="badge">VOIP</span>
      <div>
        <div class="title">WAHA Live Voice Calling</div>
        <div class="subtitle">Two-Way Live Browser Audio &bull; Direct PCM Stream &bull; Low Latency</div>
      </div>
    </div>
    <div class="header-links">
      <a href="/" class="btn-link">&larr; Main Dashboard</a>
      <button id="btnPair" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">WhatsApp Session / QR</button>
    </div>
  </header>

  <main>
    <!-- Dialer & Session Info Card -->
    <div id="dialerCard" class="card">
      <div class="card-title">
        <span>Make an Outgoing WhatsApp Voice Call</span>
        <span id="sessionStatusPill" class="status-pill pill-amber">Checking Status...</span>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label for="selectSession">WhatsApp Session</label>
          <select id="selectSession">
            ${sessions.map((s) => `<option value="${s.name}" ${s.name === defaultSession ? 'selected' : ''}>${s.name} (${s.status})</option>`).join('')}
          </select>
        </div>

        <div class="form-group">
          <label for="inputPhone">Destination WhatsApp Number (with country code)</label>
          <input type="text" id="inputPhone" placeholder="+1234567890" value="">
        </div>
      </div>

      <div style="display: flex; gap: 12px; margin-top: 8px;">
        <button id="btnStartCall" class="btn btn-green" style="flex: 1;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          Call WhatsApp Contact
        </button>
      </div>
    </div>

    <!-- Active Call Screen -->
    <div id="callScreen" class="card">
      <div class="call-avatar">&#128222;</div>
      <div id="activePeer" class="call-peer">+1234567890</div>
      <div id="activeCallStatus" class="status-pill pill-amber" style="margin-bottom: 12px;">DIALING...</div>
      <div id="callTimer" class="call-timer">00:00</div>

      <div class="call-actions">
        <button id="btnMute" class="btn btn-secondary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          <span id="muteText">Mute Mic</span>
        </button>

        <button id="btnEndCall" class="btn btn-red">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/></svg>
          End Call
        </button>
      </div>
    </div>
  </main>

  <!-- Incoming Call Modal -->
  <div id="incomingModal">
    <div class="modal-content">
      <div style="font-size: 48px; margin-bottom: 12px; animation: pulse 1.5s infinite;">&#128222;</div>
      <h3 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Incoming WhatsApp Voice Call</h3>
      <div id="incomingCallerNumber" style="font-size: 16px; color: var(--text-muted); margin-bottom: 24px;">Unknown</div>

      <div style="display: flex; gap: 12px;">
        <button id="btnRejectIncoming" class="btn btn-red" style="flex: 1;">Decline</button>
        <button id="btnAcceptIncoming" class="btn btn-green" style="flex: 1;">Answer</button>
      </div>
    </div>
  </div>

  <!-- QR Pairing Modal -->
  <div id="qrModal">
    <div class="modal-content">
      <h3 style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">Pair Calling Microservice</h3>
      <p style="font-size: 13px; color: var(--text-muted);">Open WhatsApp on your phone &gt; Linked Devices &gt; Link a Device, and scan this QR code.</p>
      
      <div class="qr-container">
        <img id="qrImg" alt="Calling QR Code" src="" style="display: none;">
        <div id="qrLoading" style="width: 240px; height: 240px; display: flex; align-items: center; justify-content: center; color: #111;">Generating QR...</div>
      </div>

      <div>
        <button id="btnCloseQR" class="btn btn-secondary">Close</button>
      </div>
    </div>
  </div>

  <script>
    // PCM Audio Conversion Utilities
    function float32ToInt16LE(pcm) {
      const view = new DataView(new ArrayBuffer(pcm.length * 2));
      for (let i = 0; i < pcm.length; i++) {
        let s = pcm[i];
        if (Number.isNaN(s)) s = 0;
        else if (s > 1) s = 1;
        else if (s < -1) s = -1;
        view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      }
      return view.buffer;
    }

    function int16LEToFloat32(buf) {
      const view = new DataView(buf);
      const n = Math.floor(buf.byteLength / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = view.getInt16(i * 2, true) / 32768;
      }
      return out;
    }

    const state = {
      session: '${defaultSession}',
      currentCallId: null,
      incomingCallId: null,
      audioSocket: null,
      audioCtx: null,
      micStream: null,
      timerInterval: null,
      seconds: 0,
      isMuted: false,
    };

    const apiKey = '${config.apiKey || ''}';

    function authHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (apiKey) h['X-Api-Key'] = apiKey;
      return h;
    }

    async function checkStatus() {
      try {
        const res = await fetch('/api/calling/sessions/' + encodeURIComponent(state.session) + '/status', { headers: authHeaders() });
        const data = await res.json();
        const pill = document.getElementById('sessionStatusPill');
        if (!data.enabled) {
          pill.className = 'status-pill pill-red';
          pill.innerText = 'CALLING DISABLED';
        } else if (data.paired) {
          pill.className = 'status-pill pill-green';
          pill.innerText = 'WHATSAPP CONNECTED & READY';
        } else {
          pill.className = 'status-pill pill-amber';
          pill.innerText = 'WHATSAPP SESSION NOT CONNECTED';
        }
      } catch (err) {
        console.error(err);
      }
    }

    // Direct Live Audio Pipeline (Raw PCM 16kHz via WebSocket - bypasses all UDP/NAT/Firewall blocks)
    async function startAudioPipeline(callId) {
      state.currentCallId = callId;

      // 1. Request microphone
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      // 2. Setup AudioContext at 16 kHz
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      state.audioCtx = ctx;

      const captureCode = \`class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);\`;

      const playbackCode = \`const RING_SIZE = 16000 * 2;
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_SIZE);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.port.onmessage = (e) => {
      const data = e.data;
      for (let i = 0; i < data.length; i += 1) {
        this.ring[this.write] = data[i];
        this.write = (this.write + 1) % RING_SIZE;
        if (this.available < RING_SIZE) {
          this.available += 1;
        } else {
          this.read = (this.read + 1) % RING_SIZE;
        }
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i += 1) {
      if (this.available > 0) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % RING_SIZE;
        this.available -= 1;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("playback-processor", PlaybackProcessor);\`;

      const captureBlob = new Blob([captureCode], { type: 'application/javascript' });
      const playbackBlob = new Blob([playbackCode], { type: 'application/javascript' });
      await ctx.audioWorklet.addModule(URL.createObjectURL(captureBlob));
      await ctx.audioWorklet.addModule(URL.createObjectURL(playbackBlob));
      await ctx.resume();

      // 3. Connect resilient WebSocket audio stream
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = apiKey ? '?x-api-key=' + encodeURIComponent(apiKey) : '';
      const wsUrl = protocol + '//' + window.location.host + '/api/calling/sessions/' + encodeURIComponent(state.session) + '/calls/' + encodeURIComponent(callId) + '/socket' + qs;

      console.log('[AudioSocket] Connecting to live audio gateway:', wsUrl);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      state.audioSocket = ws;

      ws.onopen = () => {
        console.log('[AudioSocket] Connected to audio stream successfully');
      };
      ws.onclose = () => {
        console.log('[AudioSocket] Audio stream closed');
      };
      ws.onerror = (e) => {
        console.error('[AudioSocket] Audio stream error:', e);
      };

      // Mic capture -> WebSocket
      const micSource = ctx.createMediaStreamSource(state.micStream);
      const captureNode = new AudioWorkletNode(ctx, 'capture-processor');
      captureNode.port.onmessage = (e) => {
        if (!state.isMuted && ws.readyState === WebSocket.OPEN) {
          ws.send(float32ToInt16LE(e.data));
        }
      };
      micSource.connect(captureNode);

      // Dummy zero-gain to keep captureNode processing without local speaker echo
      const silenceGain = ctx.createGain();
      silenceGain.gain.value = 0;
      captureNode.connect(silenceGain);
      silenceGain.connect(ctx.destination);

      // WebSocket -> Playback speaker
      const playbackNode = new AudioWorkletNode(ctx, 'playback-processor');
      playbackNode.connect(ctx.destination);
      ws.onmessage = (e) => {
        playbackNode.port.postMessage(int16LEToFloat32(e.data));
      };
    }

    function showCallScreen() {
      document.getElementById('dialerCard').style.display = 'none';
      document.getElementById('callScreen').style.display = 'block';
      const pill = document.getElementById('activeCallStatus');
      pill.className = 'status-pill pill-amber';
      pill.innerText = 'DIALING...';
      state.seconds = 0;
      updateTimer();
    }

    function startTimer() {
      if (state.timerInterval) clearInterval(state.timerInterval);
      state.seconds = 0;
      updateTimer();
      state.timerInterval = setInterval(() => {
        state.seconds++;
        updateTimer();
      }, 1000);
    }

    function updateTimer() {
      const mins = String(Math.floor(state.seconds / 60)).padStart(2, '0');
      const secs = String(state.seconds % 60).padStart(2, '0');
      document.getElementById('callTimer').innerText = mins + ':' + secs;
    }

    function cleanupCall() {
      if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
      }
      if (state.audioSocket) {
        try { state.audioSocket.close(); } catch {}
        state.audioSocket = null;
      }
      if (state.micStream) {
        state.micStream.getTracks().forEach(t => t.stop());
        state.micStream = null;
      }
      if (state.audioCtx) {
        try { state.audioCtx.close(); } catch {}
        state.audioCtx = null;
      }
      state.currentCallId = null;
      state.incomingCallId = null;
      state.isMuted = false;

      document.getElementById('callScreen').style.display = 'none';
      document.getElementById('dialerCard').style.display = 'block';
      document.getElementById('incomingModal').style.display = 'none';
      const pill = document.getElementById('activeCallStatus');
      pill.className = 'status-pill pill-amber';
      pill.innerText = 'DIALING...';
    }

    let eventSource = null;
    function connectSSE() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      const qs = apiKey ? '?x-api-key=' + encodeURIComponent(apiKey) : '';
      const url = '/api/calling/sessions/' + encodeURIComponent(state.session) + '/events' + qs;
      const es = new EventSource(url);
      eventSource = es;

      es.addEventListener('call-ringing', (e) => {
        console.log('[SSE] Call ringing:', e.data);
        const pill = document.getElementById('activeCallStatus');
        if (pill) {
          pill.className = 'status-pill pill-amber';
          pill.innerText = 'RINGING...';
        }
      });

      es.addEventListener('call-active', (e) => {
        console.log('[SSE] Call active:', e.data);
        const pill = document.getElementById('activeCallStatus');
        if (pill) {
          pill.className = 'status-pill pill-green';
          pill.innerText = 'ACTIVE CALL';
        }
        startTimer();
      });

      es.addEventListener('call-ended', (e) => {
        console.log('[SSE] Call ended:', e.data);
        const pill = document.getElementById('activeCallStatus');
        if (pill) {
          pill.className = 'status-pill pill-red';
          let reason = '';
          try {
            const d = JSON.parse(e.data);
            if (d.endReason || d.reason) reason = ' (' + (d.endReason || d.reason) + ')';
          } catch {}
          pill.innerText = 'CALL ENDED' + reason;
        }
        if (state.timerInterval) {
          clearInterval(state.timerInterval);
          state.timerInterval = null;
        }
        setTimeout(() => {
          cleanupCall();
        }, 2200);
      });

      es.addEventListener('incoming', (e) => {
        console.log('[SSE] Incoming call:', e.data);
        try {
          const d = JSON.parse(e.data);
          state.incomingCallId = d.callId || d.id;
          document.getElementById('incomingCallerNumber').innerText = d.peer || 'Unknown';
          document.getElementById('incomingModal').style.display = 'flex';
        } catch (err) {
          console.error('Failed to parse incoming call payload:', err);
        }
      });
    }

    // Event Listeners
    document.getElementById('selectSession').addEventListener('change', (e) => {
      state.session = e.target.value;
      checkStatus();
      connectSSE();
    });

    document.getElementById('btnStartCall').addEventListener('click', async () => {
      const phone = document.getElementById('inputPhone').value.trim();
      if (!phone) {
        alert('Please enter a WhatsApp phone number');
        return;
      }
      try {
        document.getElementById('activePeer').innerText = phone;
        showCallScreen();
        const res = await fetch('/api/calling/sessions/' + encodeURIComponent(state.session) + '/calls', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (data.callId) {
          await startAudioPipeline(data.callId);
        } else {
          alert('Call error: ' + (data.error || 'Failed to start call'));
          cleanupCall();
        }
      } catch (err) {
        alert('Error initiating call: ' + err.message);
        cleanupCall();
      }
    });

    document.getElementById('btnEndCall').addEventListener('click', async () => {
      if (state.currentCallId) {
        await fetch('/api/calling/sessions/' + encodeURIComponent(state.session) + '/calls/' + encodeURIComponent(state.currentCallId), {
          method: 'DELETE',
          headers: authHeaders()
        }).catch(() => {});
      }
      cleanupCall();
    });

    document.getElementById('btnAcceptIncoming').addEventListener('click', async () => {
      if (!state.incomingCallId) return;
      document.getElementById('incomingModal').style.display = 'none';
      try {
        const caller = document.getElementById('incomingCallerNumber').innerText;
        document.getElementById('activePeer').innerText = caller;
        showCallScreen();
        const incomingId = state.incomingCallId;
        const res = await fetch('/api/calling/sessions/' + encodeURIComponent(state.session) + '/calls/' + encodeURIComponent(incomingId) + '/accept', {
          method: 'POST',
          headers: authHeaders()
        });
        const data = await res.json();
        if (data.callId) {
          state.currentCallId = data.callId;
          await startAudioPipeline(data.callId);
        }
      } catch (err) {
        alert('Failed to accept incoming call: ' + err.message);
        cleanupCall();
      }
    });

    document.getElementById('btnRejectIncoming').addEventListener('click', async () => {
      if (!state.incomingCallId) return;
      document.getElementById('incomingModal').style.display = 'none';
      try {
        await fetch('/api/calling/sessions/' + encodeURIComponent(state.session) + '/calls/' + encodeURIComponent(state.incomingCallId) + '/reject', {
          method: 'POST',
          headers: authHeaders()
        });
      } catch (err) {
        console.error('Failed to decline call:', err);
      }
      state.incomingCallId = null;
    });

    document.getElementById('btnMute').addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      document.getElementById('muteText').innerText = state.isMuted ? 'Unmute Mic' : 'Mute Mic';
      document.getElementById('btnMute').className = state.isMuted ? 'btn btn-red' : 'btn btn-secondary';
    });

    // Calling reuses the WAHA WhatsApp session (same QR): the button just opens the main dashboard
    // where that session is started / paired.
    document.getElementById('btnPair').addEventListener('click', () => {
      window.location.href = '/';
    });
    document.getElementById('btnCloseQR').addEventListener('click', () => {
      document.getElementById('qrModal').style.display = 'none';
      checkStatus();
    });

    // Initial status check & SSE
    checkStatus();
    connectSSE();
  </script>
</body>
</html>`;

  res.send(html);
});

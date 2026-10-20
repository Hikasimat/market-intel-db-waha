import { Router } from 'express';
import { config } from '../config.js';
import { sessionManager } from '../manager/session-mgr.js';
import { webhookDispatcher } from '../webhooks/dispatcher.js';
import { dashboardBasicAuth } from '../middleware/basic-auth.js';

export const healthRouter = Router();

// GET /api/dashboard/stats - Real-time monitoring data
healthRouter.get('/api/dashboard/stats', dashboardBasicAuth, (req, res) => {
  const sessions = sessionManager.listSessions().map((s) => {
    const sessionObj = sessionManager.getSession(s.name);
    const qrData = sessionObj ? sessionObj.getQR() : { raw: null, base64: null };
    return {
      ...s,
      qr: qrData.raw,
      qrBase64: qrData.base64,
    };
  });

  const memory = process.memoryUsage();
  const webhookStats = webhookDispatcher.getStats();
  const recentLogs = webhookDispatcher.getRecentLogs();
  const recentMessages = sessionManager.getAllRecentMessages();

  res.json({
    status: 'ok',
    engine: 'NOWEB',
    system: {
      uptime: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 10) / 10,
      },
      apiKeyProtected: Boolean(config.apiKey),
      nodeVersion: process.version,
    },
    webhook: {
      url: config.webhookUrl,
      events: config.webhookEvents,
      secretEnabled: Boolean(config.webhookSecret),
      stats: webhookStats,
      recentLogs,
    },
    sessions,
    messages: recentMessages,
  });
});

// POST /api/webhooks/test - Test webhook connectivity
healthRouter.post('/api/webhooks/test', dashboardBasicAuth, async (req, res) => {
  try {
    const targetUrl = req.body?.url || config.webhookUrl;
    if (!targetUrl) {
      return res.status(400).json({ error: 'No webhook URL provided or configured.' });
    }
    const result = await webhookDispatcher.testWebhook(targetUrl);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/webhooks/config - Update webhook destination URL dynamically
healthRouter.post('/api/webhooks/config', dashboardBasicAuth, (req, res) => {
  const { url, secret } = req.body || {};
  if (typeof url === 'string') {
    config.webhookUrl = url.trim() || null;
  }
  if (typeof secret === 'string') {
    config.webhookSecret = secret.trim() || null;
  }
  res.json({
    status: 'ok',
    webhookUrl: config.webhookUrl,
    secretEnabled: Boolean(config.webhookSecret),
  });
});

// GET / - Live Dashboard HTML or Service JSON
healthRouter.get('/', dashboardBasicAuth, (req, res) => {
  const sessions = sessionManager.listSessions();
  const memory = process.memoryUsage();

  if (req.accepts('html')) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAHA-NoWeb-Light Live Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070b14;
      --surface-1: #0e1526;
      --surface-2: #162138;
      --surface-3: #1f2f4e;
      --border: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(37, 211, 102, 0.5);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent: #25d366;
      --accent-hover: #1eb956;
      --accent-dim: rgba(37, 211, 102, 0.12);
      --cyan: #38bdf8;
      --cyan-dim: rgba(56, 189, 248, 0.12);
      --amber: #f59e0b;
      --amber-dim: rgba(245, 158, 11, 0.12);
      --rose: #f43f5e;
      --rose-dim: rgba(244, 63, 94, 0.12);
      --purple: #a855f7;
      --purple-dim: rgba(168, 85, 247, 0.12);
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }

    header {
      background: rgba(14, 21, 38, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .header-inner {
      max-width: 1280px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      background: linear-gradient(135deg, #25d366 0%, #128c7e 100%);
      color: #000;
      font-weight: 800;
      font-size: 16px;
      padding: 6px 12px;
      border-radius: 8px;
      letter-spacing: -0.5px;
      box-shadow: 0 0 20px rgba(37, 211, 102, 0.35);
    }
    .brand-title {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.3px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 10px var(--accent);
      animation: pulse-ring 2s infinite;
    }
    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(37, 211, 102, 0.6); }
      70% { box-shadow: 0 0 0 8px rgba(37, 211, 102, 0); }
      100% { box-shadow: 0 0 0 0 rgba(37, 211, 102, 0); }
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }
    .btn:hover {
      background: var(--surface-3);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }
    .btn-primary {
      background: var(--accent);
      color: #051c0f;
      border-color: var(--accent);
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
      color: #000;
    }

    main {
      max-width: 1280px;
      width: 100%;
      margin: 0 auto;
      padding: 24px;
      flex: 1;
    }

    .tabs-bar {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
    }
    .tab-btn.active {
      color: var(--accent);
      background: var(--accent-dim);
      border-bottom: 2px solid var(--accent);
    }
    .tab-badge {
      background: var(--surface-3);
      color: var(--text);
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--border);
    }
    .stat-card.accent-green::before { background: var(--accent); }
    .stat-card.accent-blue::before { background: var(--cyan); }
    .stat-card.accent-purple::before { background: var(--purple); }
    .stat-card.accent-amber::before { background: var(--amber); }

    .stat-head {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: var(--text);
    }
    .stat-sub {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pill {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 20px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .pill-green { background: var(--accent-dim); color: var(--accent); border: 1px solid rgba(37, 211, 102, 0.3); }
    .pill-blue { background: var(--cyan-dim); color: var(--cyan); border: 1px solid rgba(56, 189, 248, 0.3); }
    .pill-amber { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3); }
    .pill-rose { background: var(--rose-dim); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.3); }
    .pill-purple { background: var(--purple-dim); color: var(--purple); border: 1px solid rgba(168, 85, 247, 0.3); }

    .card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: var(--shadow);
    }
    .card-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .log-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .log-table th {
      text-align: left;
      padding: 10px 14px;
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-2);
    }
    .log-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .log-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .code-chip {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--cyan);
    }

    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 28px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 16px 0;
      text-align: center;
    }
    .qr-image-wrapper {
      background: #ffffff;
      padding: 14px;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: inline-block;
      margin-bottom: 16px;
    }
    .qr-image-wrapper img {
      width: 250px;
      height: 250px;
      display: block;
    }

    .form-group {
      margin-bottom: 16px;
    }
    .form-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .input {
      width: 100%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }
    .input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-dim);
    }
    textarea.input {
      resize: vertical;
      min-height: 80px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }

    .json-box {
      background: #050811;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #93c5fd;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 250px;
    }

    .text-muted { color: var(--text-muted); }
    .text-sm { font-size: 13px; }
    .flex-row { display: flex; align-items: center; gap: 10px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) {
      .grid-2 { grid-template-columns: 1fr; }
      .header-inner { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <div class="brand-logo">WAHA</div>
        <div>
          <div class="brand-title">
            WAHA-NoWeb-Light
            <span class="pulse-dot"></span>
            <span style="font-size: 12px; font-weight: 500; color: var(--text-muted);">NOWEB (Baileys)</span>
          </div>
          <div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
            Ultra-Lightweight Protocol Gateway &bull; Webhook-First Architecture
          </div>
        </div>
      </div>
      <div class="nav-actions">
        <span id="headerSyncTime" class="text-sm text-muted">Syncing...</span>
        <button class="btn btn-primary" onclick="forceRefreshData()">Refresh</button>
      </div>
    </div>
  </header>

  <main>
    <!-- Top Stats Cards -->
    <div class="stats-grid">
      <div class="stat-card accent-green">
        <div class="stat-head">
          <span>WhatsApp Status</span>
          <span id="statStatusPill" class="pill pill-amber">SCANNING</span>
        </div>
        <div id="statStatusVal" class="stat-value">Awaiting Scan</div>
        <div id="statStatusSub" class="stat-sub">Session: default</div>
      </div>

      <div class="stat-card accent-purple">
        <div class="stat-head">
          <span>Webhook Dispatcher</span>
          <span id="statWebhookPill" class="pill pill-green">ACTIVE</span>
        </div>
        <div id="statWebhookVal" class="stat-value">0 Dispatched</div>
        <div id="statWebhookSub" class="stat-sub">0 Delivered &bull; 0 Failed</div>
      </div>

      <div class="stat-card accent-blue">
        <div class="stat-head">
          <span>RAM / Resource</span>
          <span class="pill pill-blue">&lt; 50 MB RSS</span>
        </div>
        <div id="statMemoryVal" class="stat-value">-- MB</div>
        <div id="statUptimeVal" class="stat-sub">Uptime: --s</div>
      </div>

      <div class="stat-card accent-amber">
        <div class="stat-head">
          <span>Cryptographic Security</span>
          <span id="statSecurityPill" class="pill pill-green">HMAC-SHA512</span>
        </div>
        <div id="statSecurityVal" class="stat-value">Tamper-Proof</div>
        <div class="stat-sub">Replay Protection: &plusmn;5 mins</div>
      </div>
    </div>

    <!-- Tab Buttons -->
    <div class="tabs-bar">
      <button class="tab-btn active" onclick="switchTab('overview')">Overview</button>
      <button class="tab-btn" onclick="switchTab('session')">
        WhatsApp Sessions &amp; QR
        <span id="tabSessionBadge" class="tab-badge">1</span>
      </button>
      <button class="tab-btn" onclick="switchTab('webhooks')">
        Live Webhook Stream
        <span id="tabWebhookBadge" class="tab-badge">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('messages')">
        Recent Messages
        <span id="tabMessagesBadge" class="tab-badge">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('console')">API Console</button>
      <button class="tab-btn" onclick="switchTab('security')">Security &amp; API Key</button>
    </div>

    <!-- TAB 1: OVERVIEW -->
    <div id="tab-overview" class="tab-content">
      <div class="card">
        <div class="card-title">
          <span>📡 Configured Webhook Destination</span>
          <button class="btn" onclick="triggerTestWebhook()">Send Test Ping</button>
        </div>
        <p class="text-sm text-muted" style="margin-bottom: 12px;">
          All WhatsApp events (including authentication QR codes, pairing codes, lifecycle state changes, incoming messages, and delivery receipts) are dispatched automatically to this endpoint.
        </p>
        <div style="background: var(--surface-2); padding: 14px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 700;">Target URL</div>
            <div id="overviewWebhookUrl" class="code-chip" style="font-size: 14px; margin-top: 4px; display: inline-block;">Loading...</div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 700;">Event Scope</div>
            <div id="overviewWebhookEvents" class="pill pill-purple" style="margin-top: 4px;">* (ALL EVENTS)</div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 700;">Tamper Protection</div>
            <div id="overviewWebhookHmac" class="pill pill-green" style="margin-top: 4px;">HMAC-SHA512 ACTIVE</div>
          </div>
        </div>
        <div id="testPingResultBox" style="display: none; margin-top: 14px; padding: 12px; border-radius: var(--radius-sm); font-size: 13px;"></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">
            <span>📱 Primary Session</span>
            <span id="overviewSessionPill" class="pill pill-amber">STOPPED</span>
          </div>
          <div id="overviewSessionBody" style="font-size: 14px; color: var(--text-muted);">
            Checking session state...
          </div>
          <div style="margin-top: 18px; display: flex; gap: 8px;">
            <button class="btn btn-primary" onclick="forceDispatchQr()">Force Re-Dispatch QR to Webhook</button>
            <button class="btn" onclick="switchTab('session')">View QR &amp; Connect</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>⚡ System Performance</span>
            <span class="pill pill-blue">NOWEB (Baileys)</span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Node.js</div>
              <div id="overviewNodeVer" style="font-size: 15px; font-weight: 700; margin-top: 4px;">--</div>
            </div>
            <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Heap Memory</div>
              <div id="overviewHeapMem" style="font-size: 15px; font-weight: 700; margin-top: 4px;">-- MB</div>
            </div>
            <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">API Key Lock</div>
              <div id="overviewApiKeyLock" style="font-size: 15px; font-weight: 700; margin-top: 4px;">--</div>
            </div>
            <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Total Webhook Calls</div>
              <div id="overviewWebhookCalls" style="font-size: 15px; font-weight: 700; margin-top: 4px;">0</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: WHATSAPP SESSIONS & QR -->
    <div id="tab-session" class="tab-content" style="display: none;">
      <div id="sessionsListContainer">
        <!-- Rendered dynamically -->
      </div>
    </div>

    <!-- TAB 3: LIVE WEBHOOK STREAM -->
    <div id="tab-webhooks" class="tab-content" style="display: none;">
      <div class="card">
        <div class="card-title">
          <span>📡 Live Webhook Activity Feed</span>
          <div class="flex-row">
            <span id="webhookCountBadge" class="pill pill-purple">0 Events</span>
            <button class="btn" onclick="triggerTestWebhook()">Send Diagnostic Ping</button>
          </div>
        </div>
        <p class="text-sm text-muted" style="margin-bottom: 16px;">
          Real-time record of all outbound events dispatched to your server, complete with HTTP status codes, latencies, and HMAC cryptographic verification headers.
        </p>

        <!-- Webhook destination URL editor -->
        <div style="background: var(--surface-2); padding: 14px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 280px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 700; margin-bottom: 6px;">Update Webhook Destination URL Live</div>
            <input id="editWebhookUrlInput" class="input" type="text" style="padding: 8px 12px; font-size: 13px;" placeholder="http://host.docker.internal:8000/api/whatsapp/webhook/">
          </div>
          <div style="display: flex; gap: 8px; align-self: flex-end;">
            <button class="btn btn-primary" onclick="saveWebhookUrl()">Update URL</button>
          </div>
        </div>

        <div id="econnrefusedNotice" style="display: none; background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); padding: 12px 16px; border-radius: var(--radius-sm); margin-bottom: 16px; font-size: 13px; color: #fca5a5;">
          ⚠️ <b>Notice (ECONNREFUSED):</b> The target server on port 8000 is not running yet. Start your webhook server (e.g. FastAPI/Django/Node) on port 8000 or enter an active URL above (e.g. from Webhook.site or ngrok) to receive events immediately.
        </div>

        <div style="overflow-x: auto;">
          <table class="log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Session</th>
                <th>Target URL</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Security</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="webhookLogsBody">
              <tr>
                <td colspan="8" style="text-align: center; color: var(--text-dim); padding: 24px;">No webhook events recorded yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 4: RECENT MESSAGES -->
    <div id="tab-messages" class="tab-content" style="display: none;">
      <div class="card">
        <div class="card-title">
          <span>💬 Gateway Message Stream</span>
          <span id="messagesCountBadge" class="pill pill-blue">0 Messages</span>
        </div>
        <div style="overflow-x: auto;">
          <table class="log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Direction</th>
                <th>From / To</th>
                <th>Message Content</th>
                <th>Media</th>
                <th>Receipt (Ack)</th>
              </tr>
            </thead>
            <tbody id="messagesTableBody">
              <tr>
                <td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">No messages sent or received yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 5: API CONSOLE -->
    <div id="tab-console" class="tab-content" style="display: none;">
      <!-- Active API Key bar for Console -->
      <div style="background: var(--surface-2); padding: 12px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span class="pill pill-green">🔒 AUTHENTICATION</span>
          <span style="font-size: 13px; color: var(--text-muted);">API Key used for Console Requests:</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <input id="consoleApiKeyInput" class="input" style="width: 260px; padding: 6px 12px; font-size: 13px;" type="text" placeholder="Enter API Key">
          <button class="btn" style="padding: 6px 12px;" onclick="saveConsoleApiKey()">Save Key</button>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">
            <span>✉️ Send WhatsApp Message</span>
            <span class="pill pill-green">POST /api/sendText</span>
          </div>
          <div class="form-group">
            <label class="form-label">Session Name</label>
            <input id="apiSessionInput" class="input" type="text" value="default">
          </div>
          <div class="form-group">
            <label class="form-label">Recipient Phone Number / Chat ID</label>
            <input id="apiChatIdInput" class="input" type="text" placeholder="e.g. 1234567890 or 1234567890@c.us">
          </div>
          <div class="form-group">
            <label class="form-label">Message Text</label>
            <textarea id="apiTextInput" class="input" placeholder="Type your message here..."></textarea>
          </div>
          <button class="btn btn-primary" style="width: 100%;" onclick="executeSendText()">
            Send WhatsApp Message
          </button>
          <div id="apiSendResult" style="display: none; margin-top: 14px;" class="json-box"></div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>🔍 Contact Number Verification</span>
            <span class="pill pill-blue">GET /api/contacts/check-exists</span>
          </div>
          <div class="form-group">
            <label class="form-label">Phone Number to Check</label>
            <input id="apiCheckPhoneInput" class="input" type="text" placeholder="e.g. 1234567890">
          </div>
          <button class="btn" style="width: 100%;" onclick="executeCheckNumber()">
            Check WhatsApp Registration
          </button>
          <div id="apiCheckResult" style="display: none; margin-top: 14px;" class="json-box"></div>

          <hr style="border: 0; border-top: 1px solid var(--border); margin: 24px 0;">

          <div class="card-title">
            <span>🔄 Webhook QR Re-Dispatch</span>
            <span class="pill pill-purple">POST /api/:session/auth/qr/dispatch</span>
          </div>
          <p class="text-sm text-muted" style="margin-bottom: 12px;">
            Forces WAHA to package the current session QR code and push it to your webhook endpoint immediately.
          </p>
          <button class="btn" style="width: 100%;" onclick="forceDispatchQr()">
            Force Dispatch QR Code
          </button>
        </div>
      </div>
    </div>

    <!-- TAB 6: SECURITY & API KEY -->
    <div id="tab-security" class="tab-content" style="display: none;">
      <div class="card">
        <div class="card-title">
          <span>🔒 Webhook Cryptographic Verification</span>
          <span class="pill pill-green">HMAC-SHA512</span>
        </div>
        <p class="text-sm text-muted" style="margin-bottom: 14px;">
          Every webhook delivery is cryptographically signed using a shared secret key (<code class="code-chip">WHATSAPP_HOOK_SECRET</code>). The signature covers both the millisecond timestamp and the raw JSON payload to prevent data tampering, eavesdropping, and replay attacks.
        </p>

        <div class="json-box">
// Node.js Verification Example:
const computed = crypto
  .createHmac('sha512', WEBHOOK_SECRET)
  .update(\`\${req.headers['x-webhook-timestamp']}.\${req.rawBody}\`)
  .digest('hex');

const isTamperProof = crypto.timingSafeEqual(
  Buffer.from(computed, 'hex'),
  Buffer.from(req.headers['x-webhook-hmac'], 'hex')
);
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>🔑 Dashboard API Key Configuration</span>
          <span id="apiKeyStatusPill" class="pill pill-blue">CHECKING</span>
        </div>
        <p class="text-sm text-muted" style="margin-bottom: 14px;">
          If <code class="code-chip">WAHA_API_KEY</code> is enabled in your environment, enter it here so this browser dashboard can authenticate with your WAHA engine endpoints.
        </p>
        <div class="form-group">
          <label class="form-label">WAHA API Key</label>
          <input id="localApiKeyInput" class="input" type="password" placeholder="Enter WAHA_API_KEY">
        </div>
        <button class="btn btn-primary" onclick="saveLocalApiKey()">Save Key to Browser</button>
      </div>
    </div>
  </main>

  <!-- Modal for JSON Inspection -->
  <div id="inspectModal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); z-index: 100; align-items: center; justify-content: center; padding: 20px;">
    <div style="background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); max-width: 700px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow);">
      <div style="padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between;">
        <div id="inspectModalTitle" style="font-weight: 700; font-size: 15px;">Payload Details</div>
        <button class="btn" onclick="closeInspectModal()">Close</button>
      </div>
      <div style="padding: 20px; overflow-y: auto; flex: 1;">
        <div id="inspectModalContent" class="json-box" style="max-height: 400px;"></div>
      </div>
      <div style="padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-primary" onclick="copyInspectContent()">Copy JSON</button>
      </div>
    </div>
  </div>

  <script>
    window.__DEFAULT_API_KEY__ = ${JSON.stringify(config.apiKey || '')};
    let globalStats = null;
    let currentTab = 'overview';
    let pollInterval = null;

    function getApiKey() {
      const local = localStorage.getItem('waha_dashboard_api_key');
      if (local !== null && local !== undefined && local.length > 0) return local;
      return window.__DEFAULT_API_KEY__ || '';
    }

    function saveLocalApiKey() {
      const val = document.getElementById('localApiKeyInput').value.trim();
      localStorage.setItem('waha_dashboard_api_key', val);
      const consoleInput = document.getElementById('consoleApiKeyInput');
      if (consoleInput) consoleInput.value = val;
      alert('API Key saved to browser storage!');
      forceRefreshData();
    }

    function saveConsoleApiKey() {
      const val = document.getElementById('consoleApiKeyInput').value.trim();
      localStorage.setItem('waha_dashboard_api_key', val);
      const input = document.getElementById('localApiKeyInput');
      if (input) input.value = val;
      alert('API Key updated and saved!');
      forceRefreshData();
    }

    function switchTab(tabId) {
      currentTab = tabId;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

      const targetTab = document.getElementById('tab-' + tabId);
      if (targetTab) targetTab.style.display = 'block';

      event?.currentTarget?.classList?.add('active') ||
        Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabId))?.classList?.add('active');
    }

    async function fetchStats() {
      try {
        const apiKey = getApiKey();
        const headers = { 'Accept': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/dashboard/stats', { headers });
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        const data = await res.json();
        globalStats = data;
        renderDashboard(data);
      } catch (err) {
        document.getElementById('headerSyncTime').innerText = 'Sync failed: ' + err.message;
      }
    }

    function renderDashboard(data) {
      document.getElementById('headerSyncTime').innerText = 'Live Sync: ' + new Date().toLocaleTimeString();

      const primarySession = data.sessions[0];
      if (primarySession) {
        const isConnected = primarySession.status === 'WORKING';
        const isScanning = primarySession.status === 'SCAN_QR_CODE';

        document.getElementById('statStatusVal').innerText = isConnected
          ? (primarySession.me ? '+' + primarySession.me.phone : 'Connected')
          : (isScanning ? 'Scan QR Code' : primarySession.status);

        document.getElementById('statStatusPill').innerText = primarySession.status;
        document.getElementById('statStatusPill').className = 'pill ' +
          (isConnected ? 'pill-green' : (isScanning ? 'pill-amber' : 'pill-rose'));

        document.getElementById('statStatusSub').innerText = 'Session: ' + primarySession.name +
          (primarySession.me?.name ? ' (' + primarySession.me.name + ')' : '');
      }

      const wh = data.webhook;
      document.getElementById('statWebhookVal').innerText = (wh.stats?.total || 0) + ' Dispatched';
      document.getElementById('statWebhookSub').innerText =
        (wh.stats?.delivered || 0) + ' Delivered • ' + (wh.stats?.failed || 0) + ' Failed';
      document.getElementById('tabWebhookBadge').innerText = wh.stats?.total || 0;
      document.getElementById('webhookCountBadge').innerText = (wh.recentLogs?.length || 0) + ' Events Recorded';

      document.getElementById('statMemoryVal').innerText = data.system.memory.rssMb + ' MB RSS';
      document.getElementById('statUptimeVal').innerText = 'Uptime: ' + data.system.uptime + 's';

      document.getElementById('statSecurityPill').innerText = wh.secretEnabled ? 'HMAC-SHA512' : 'SHA-256 DIGEST';
      document.getElementById('statSecurityVal').innerText = wh.secretEnabled ? 'Tamper-Proof' : 'Integrity Only';

      document.getElementById('overviewWebhookUrl').innerText = wh.url || 'None (Set WHATSAPP_HOOK_URL)';
      document.getElementById('overviewWebhookEvents').innerText = wh.events?.join(', ') || '*';
      document.getElementById('overviewWebhookHmac').innerText = wh.secretEnabled ? 'HMAC-SHA512 ACTIVE' : 'NO SECRET SET';
      document.getElementById('overviewWebhookHmac').className = 'pill ' + (wh.secretEnabled ? 'pill-green' : 'pill-amber');

      const editInput = document.getElementById('editWebhookUrlInput');
      if (editInput && !editInput.matches(':focus') && wh.url) {
        editInput.value = wh.url;
      }

      // Check if ECONNREFUSED notice should show
      const hasConnRefused = wh.recentLogs?.some(l => l.error && l.error.includes('ECONNREFUSED'));
      const noticeBox = document.getElementById('econnrefusedNotice');
      if (noticeBox) {
        noticeBox.style.display = hasConnRefused ? 'block' : 'none';
      }

      if (primarySession) {
        document.getElementById('overviewSessionPill').innerText = primarySession.status;
        document.getElementById('overviewSessionPill').className = 'pill ' +
          (primarySession.status === 'WORKING' ? 'pill-green' : 'pill-amber');
        document.getElementById('overviewSessionBody').innerHTML = \`
          <div><b>Session:</b> \${primarySession.name}</div>
          <div style="margin-top: 4px;"><b>Status:</b> \${primarySession.status}</div>
          <div style="margin-top: 4px;"><b>Connected Phone:</b> \${primarySession.me ? primarySession.me.phone : 'Not connected'}</div>
        \`;
      }

      document.getElementById('overviewNodeVer').innerText = data.system.nodeVersion;
      document.getElementById('overviewHeapMem').innerText = data.system.memory.heapUsedMb + ' MB';
      document.getElementById('overviewApiKeyLock').innerText = data.system.apiKeyProtected ? 'LOCKED' : 'PUBLIC';
      document.getElementById('overviewWebhookCalls').innerText = wh.stats?.total || 0;

      renderSessions(data.sessions);
      renderWebhookLogs(wh.recentLogs || []);
      renderMessages(data.messages || []);
    }

    function renderSessions(sessions) {
      const container = document.getElementById('sessionsListContainer');
      document.getElementById('tabSessionBadge').innerText = sessions.length;

      if (!sessions || sessions.length === 0) {
        container.innerHTML = '<div class="card text-muted">No sessions active.</div>';
        return;
      }

      container.innerHTML = sessions.map(s => {
        const isScanning = s.status === 'SCAN_QR_CODE';
        const isConnected = s.status === 'WORKING';

        return \`
          <div class="card">
            <div class="card-title">
              <div>
                <span>Session: <b>\${s.name}</b></span>
                <span class="pill \${isConnected ? 'pill-green' : (isScanning ? 'pill-amber' : 'pill-rose')}" style="margin-left: 8px;">
                  \${s.status}
                </span>
              </div>
              <div class="flex-row">
                <button class="btn btn-primary" onclick="forceDispatchQr('\${s.name}')">Force Push QR to Webhook</button>
              </div>
            </div>

            \${isScanning && s.qrBase64 ? \`
              <div class="qr-container">
                <div class="qr-image-wrapper">
                  <img src="\${s.qrBase64}" alt="Scan QR in WhatsApp">
                </div>
                <div style="font-weight: 700; font-size: 16px;">Scan with WhatsApp</div>
                <div class="text-sm text-muted" style="margin-top: 4px; max-width: 400px;">
                  Open WhatsApp on your phone &bull; Settings &bull; Linked Devices &bull; Link a Device
                </div>
                <div style="margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;">
                  <button class="btn" onclick="copyText('\${s.qr}')">Copy Raw QR Text</button>
                  <button class="btn" onclick="promptPairingCode('\${s.name}')">Pair with Phone Number (No QR)</button>
                </div>
              </div>
            \` : ''}

            \${isConnected ? \`
              <div style="background: var(--surface-2); padding: 18px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
                <div style="display: flex; align-items: center; gap: 14px;">
                  <div style="width: 48px; height: 48px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 800;">
                    WA
                  </div>
                  <div>
                    <div style="font-size: 16px; font-weight: 700;">+\${s.me?.phone || 'Connected'}</div>
                    <div class="text-sm text-muted">ID: \${s.me?.id || s.name}</div>
                  </div>
                </div>
                <div>
                  <span class="pill pill-green">&bull; ONLINE &amp; LISTENING</span>
                </div>
              </div>
            \` : ''}
          </div>
        \`;
      }).join('');
    }

    function renderWebhookLogs(logs) {
      const tbody = document.getElementById('webhookLogsBody');
      if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 24px;">No webhook events recorded yet.</td></tr>';
        return;
      }

      tbody.innerHTML = logs.map(l => {
        const isSuccess = l.status === 'DELIVERED';
        const isFailed = l.status === 'FAILED';
        const dateStr = new Date(l.timestamp).toLocaleTimeString();

        let eventClass = 'pill-purple';
        if (l.event.startsWith('message')) eventClass = 'pill-green';
        if (l.event.startsWith('session')) eventClass = 'pill-blue';
        if (l.event.startsWith('presence')) eventClass = 'pill-cyan';

        return \`
          <tr>
            <td style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">\${dateStr}</td>
            <td><span class="pill \${eventClass}">\${l.event}</span></td>
            <td><span class="code-chip">\${l.session}</span></td>
            <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              <span class="text-sm" title="\${l.url}">\${l.url}</span>
            </td>
            <td>
              <span class="pill \${isSuccess ? 'pill-green' : (isFailed ? 'pill-rose' : 'pill-amber')}">
                \${isSuccess ? '200 OK' : (l.error ? l.error.split(':')[0] : l.status)}
              </span>
            </td>
            <td style="font-size: 12px; color: var(--text-muted);">\${l.durationMs}ms</td>
            <td>
              <span class="pill pill-green" title="\${l.hmacSignature || ''}">SIGNED</span>
            </td>
            <td>
              <button class="btn" style="padding: 4px 8px; font-size: 11px;" onclick='openInspectModal("\${l.event}", \${JSON.stringify(l.payloadSummary)})'>
                Inspect
              </button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderMessages(messages) {
      const tbody = document.getElementById('messagesTableBody');
      document.getElementById('tabMessagesBadge').innerText = messages.length;

      if (!messages || messages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">No messages sent or received yet.</td></tr>';
        return;
      }

      tbody.innerHTML = messages.map(m => {
        const timeStr = new Date(m.timestamp * 1000).toLocaleTimeString();
        const isFromMe = m.fromMe;

        return \`
          <tr>
            <td style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">\${timeStr}</td>
            <td>
              <span class="pill \${isFromMe ? 'pill-blue' : 'pill-green'}">
                \${isFromMe ? 'OUTGOING' : 'INCOMING'}
              </span>
            </td>
            <td>
              <div class="code-chip">\${isFromMe ? m.to : m.from}</div>
            </td>
            <td style="max-width: 350px;">
              <div style="font-size: 13px; word-break: break-word;">\${m.body || '(Media or system message)'}</div>
            </td>
            <td>
              \${m.hasMedia ? '<span class="pill pill-purple">MEDIA</span>' : '<span style="color: var(--text-dim);">&mdash;</span>'}
            </td>
            <td>
              <span class="pill pill-blue">\${m.ackName || m.ack}</span>
            </td>
          </tr>
        \`;
      }).join('');
    }

    async function triggerTestWebhook() {
      const box = document.getElementById('testPingResultBox');
      box.style.display = 'block';
      box.style.background = 'var(--surface-2)';
      box.style.color = 'var(--text)';
      box.innerHTML = '⏳ Dispatching diagnostic HMAC ping to webhook destination...';

      try {
        const apiKey = getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const targetUrl = document.getElementById('editWebhookUrlInput')?.value?.trim() || '';
        const res = await fetch('/api/webhooks/test', {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: targetUrl })
        });
        const data = await res.json();

        if (data.success) {
          box.style.background = 'var(--accent-dim)';
          box.style.color = 'var(--accent)';
          box.innerHTML = '✅ <b>Webhook Verified:</b> Destination received diagnostic payload (Status: ' + data.statusCode + ') in ' + data.durationMs + 'ms with cryptographic HMAC signature.';
        } else {
          box.style.background = 'var(--rose-dim)';
          box.style.color = 'var(--rose)';
          box.innerHTML = '❌ <b>Delivery Failed:</b> ' + (data.error || 'Server error') + ' (' + data.durationMs + 'ms). Verify that your webhook service is running at ' + data.targetUrl;
        }
        fetchStats();
      } catch (err) {
        box.style.background = 'var(--rose-dim)';
        box.style.color = 'var(--rose)';
        box.innerHTML = '❌ Request failed: ' + err.message;
      }
    }

    async function saveWebhookUrl() {
      const url = document.getElementById('editWebhookUrlInput').value.trim();
      if (!url) return alert('Enter a webhook URL');
      try {
        const apiKey = getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/webhooks/config', {
          method: 'POST',
          headers,
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        alert('✅ Webhook URL updated to: ' + data.webhookUrl);
        fetchStats();
      } catch (err) {
        alert('Failed to update URL: ' + err.message);
      }
    }

    async function forceDispatchQr(sessionName = 'default') {
      try {
        const apiKey = getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/' + sessionName + '/auth/qr/dispatch', {
          method: 'POST',
          headers,
        });
        const data = await res.json();
        if (res.ok) {
          alert('🚀 QR code successfully dispatched to webhook!');
          fetchStats();
        } else {
          alert('Could not dispatch QR: ' + (data.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Failed to dispatch QR: ' + err.message);
      }
    }

    async function promptPairingCode(sessionName) {
      const phone = prompt('Enter your WhatsApp phone number with country code (e.g. 1234567890):');
      if (!phone) return;

      try {
        const apiKey = getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/' + sessionName + '/auth/request-code', {
          method: 'POST',
          headers,
          body: JSON.stringify({ phoneNumber: phone })
        });
        const data = await res.json();
        if (res.ok && data.code) {
          alert('✅ 8-digit Pairing Code: ' + data.code + '\\n\\nEnter this code on your WhatsApp phone when prompted!');
          fetchStats();
        } else {
          alert('Pairing code request failed: ' + (data.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Error requesting code: ' + err.message);
      }
    }

    async function executeSendText() {
      const session = document.getElementById('apiSessionInput').value.trim() || 'default';
      const chatId = document.getElementById('apiChatIdInput').value.trim();
      const text = document.getElementById('apiTextInput').value.trim();
      const resultBox = document.getElementById('apiSendResult');

      if (!chatId || !text) {
        alert('Please provide both recipient phone number and message text.');
        return;
      }

      resultBox.style.display = 'block';
      resultBox.innerText = 'Sending message to WhatsApp...';

      try {
        const apiKey = document.getElementById('consoleApiKeyInput')?.value?.trim() || getApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/sendText', {
          method: 'POST',
          headers,
          body: JSON.stringify({ session, chatId, text })
        });
        const data = await res.json();
        resultBox.innerText = JSON.stringify(data, null, 2);
        fetchStats();
      } catch (err) {
        resultBox.innerText = 'Error: ' + err.message;
      }
    }

    async function executeCheckNumber() {
      const phone = document.getElementById('apiCheckPhoneInput').value.trim();
      const resultBox = document.getElementById('apiCheckResult');
      if (!phone) {
        alert('Enter a phone number to check');
        return;
      }

      resultBox.style.display = 'block';
      resultBox.innerText = 'Checking WhatsApp registration...';

      try {
        const apiKey = document.getElementById('consoleApiKeyInput')?.value?.trim() || getApiKey();
        const headers = {};
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['authorization'] = 'Bearer ' + apiKey;
        }

        const res = await fetch('/api/contacts/check-exists?session=default&phone=' + encodeURIComponent(phone), {
          headers
        });
        const data = await res.json();
        resultBox.innerText = JSON.stringify(data, null, 2);
      } catch (err) {
        resultBox.innerText = 'Error: ' + err.message;
      }
    }

    function openInspectModal(event, payload) {
      document.getElementById('inspectModalTitle').innerText = 'Event: ' + event;
      document.getElementById('inspectModalContent').innerText = JSON.stringify(payload, null, 2);
      document.getElementById('inspectModal').style.display = 'flex';
    }

    function closeInspectModal() {
      document.getElementById('inspectModal').style.display = 'none';
    }

    function copyInspectContent() {
      const text = document.getElementById('inspectModalContent').innerText;
      navigator.clipboard.writeText(text);
      alert('Payload JSON copied to clipboard!');
    }

    function copyText(val) {
      navigator.clipboard.writeText(val);
      alert('Copied to clipboard!');
    }

    function forceRefreshData() {
      fetchStats();
    }

    document.addEventListener('DOMContentLoaded', () => {
      const initialKey = getApiKey();
      if (initialKey && !localStorage.getItem('waha_dashboard_api_key')) {
        localStorage.setItem('waha_dashboard_api_key', initialKey);
      }

      const input = document.getElementById('localApiKeyInput');
      if (input) input.value = initialKey;
      const consoleInput = document.getElementById('consoleApiKeyInput');
      if (consoleInput) consoleInput.value = initialKey;

      fetchStats();
      pollInterval = setInterval(fetchStats, 2500);
    });
  </script>
</body>
</html>`;
    return res.send(html);
  }

  res.json({
    status: 'ok',
    engine: 'NOWEB',
    webhook: {
      url: config.webhookUrl,
      events: config.webhookEvents,
      signedHmac: Boolean(config.webhookSecret),
    },
    sessions: sessions.length,
    uptime: Math.floor(process.uptime()),
    memory: {
      rssMb: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
      heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
    },
  });
});

healthRouter.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    engine: 'NOWEB',
    memory: {
      rssMb: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
      heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 100) / 100,
    },
  });
});

healthRouter.get('/ping', (req, res) => {
  res.send('pong');
});

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware that enforces HTTP Basic Auth on dashboard / UI endpoints.
 * Also permits requests presenting a valid X-Api-Key or Bearer token matching config.apiKey.
 */
export function dashboardBasicAuth(req: Request, res: Response, next: NextFunction) {
  // If disabled in config, allow access
  if (!config.dashboardAuthEnabled) {
    return next();
  }

  // Allow bypassing if a valid API key or dashboard password is supplied via headers or query
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const bearerHeader = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : undefined;
  const providedKey = apiKeyHeader || bearerHeader || (req.query.apiKey as string | undefined);

  const validKeys = [config.apiKey, config.dashboardPassword].filter(Boolean) as string[];
  if (providedKey && validKeys.some((k) => safeCompare(providedKey, k))) {
    return next();
  }

  // Check HTTP Basic Auth: Authorization: Basic base64(user:pass)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.slice(6).trim();
    try {
      const decoded = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      if (colonIndex !== -1) {
        const username = decoded.slice(0, colonIndex);
        const password = decoded.slice(colonIndex + 1);

        const expectedUser = config.dashboardUsername;
        const expectedPass = config.dashboardPassword;

        if (safeCompare(username, expectedUser) && safeCompare(password, expectedPass)) {
          return next();
        }
      }
    } catch {
      // Malformed base64, fall through to 401
    }
  }

  // Only challenge browser with WWW-Authenticate header when requesting HTML pages directly.
  // For background JSON/API fetch calls, do NOT send WWW-Authenticate to avoid endless browser popups!
  const isApiRequest = req.path.startsWith('/api/') || req.xhr || req.headers['accept']?.includes('application/json');
  if (!isApiRequest) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WAHA Live Monitor - Restricted Area", charset="UTF-8"');
    if (req.accepts('html')) {
      return res.status(401).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>401 Unauthorized - WAHA Live Monitor</title>
  <style>
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .box {
      background: #111827;
      border: 1px solid #1f293d;
      border-radius: 12px;
      padding: 32px;
      max-width: 440px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .icon {
      font-size: 40px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 10px;
      color: #ef4444;
    }
    p {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .btn {
      background: #25d366;
      color: #000;
      text-decoration: none;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 8px;
      display: inline-block;
      cursor: pointer;
      border: none;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔒</div>
    <h1>401 - Authentication Required</h1>
    <p>Access to WAHA-NoWeb-Light Live Monitor is protected. Please enter your valid administrator credentials to proceed.</p>
    <button class="btn" onclick="window.location.reload()">Sign In</button>
  </div>
</body>
</html>
    `);
  }

  return res.status(401).json({
    statusCode: 401,
    message: 'Unauthorized: Valid HTTP Basic Auth or API Key required to access this endpoint.',
    error: 'Unauthorized',
  });
}

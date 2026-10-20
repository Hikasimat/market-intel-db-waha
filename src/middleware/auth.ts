import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  // Public endpoints that do not require an API key
  if (req.path === '/health' || req.path === '/ping') {
    return next();
  }

  // If no API key configured on server, allow all
  if (!config.apiKey) {
    return next();
  }

  // 1. Check x-api-key header
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey === config.apiKey) {
    return next();
  }

  // 2. Check Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken === config.apiKey) {
      return next();
    }
  }

  // 3. Check query param ?x-api-key=
  const queryKey = req.query['x-api-key'];
  if (typeof queryKey === 'string' && queryKey === config.apiKey) {
    return next();
  }

  return res.status(401).json({
    statusCode: 401,
    message: 'Unauthorized: Invalid or missing API key',
    error: 'Unauthorized',
  });
}

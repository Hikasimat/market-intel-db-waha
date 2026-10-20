import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { logger } from './logger.js';
import { apiKeyAuth } from './middleware/auth.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { authRouter } from './routes/auth.js';
import { chattingRouter } from './routes/chatting.js';
import { contactsRouter } from './routes/contacts.js';
import { groupsRouter } from './routes/groups.js';
import { filesRouter } from './routes/files.js';

export function createApp(): Express {
  const app = express();

  // Basic security and parsing middlewares
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/health' && req.path !== '/ping') {
        logger.info({
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          durationMs: duration,
        }, `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });

  // Public health routes
  app.use(healthRouter);

  // Authentication barrier
  app.use(apiKeyAuth);

  // Authenticated routes
  app.use(sessionsRouter);
  app.use(authRouter);
  app.use(chattingRouter);
  app.use(contactsRouter);
  app.use(groupsRouter);
  app.use(filesRouter);

  // 404 Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      statusCode: 404,
      message: `Cannot ${req.method} ${req.path}`,
      error: 'Not Found',
    });
  });

  // Central Error Handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path }, `Unhandled server error: ${err.message}`);
    const statusCode = err.status || err.statusCode || 500;
    res.status(statusCode).json({
      statusCode,
      message: err.message || 'Internal Server Error',
      error: err.name || 'Error',
    });
  });

  return app;
}

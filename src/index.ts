import fs from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import { createApp } from './server.js';
import { sessionManager } from './manager/session-mgr.js';

async function bootstrap() {
  logger.info(`WAHA-NoWeb-Light starting up...`);
  logger.info(`Engine: NOWEB (pure Baileys WebSocket protocol)`);
  logger.info(`Configured sessions directory: ${config.sessionsDir}`);
  logger.info(`Configured media directory: ${config.mediaDir}`);

  // Ensure directories exist
  await fs.mkdir(config.sessionsDir, { recursive: true });
  await fs.mkdir(config.mediaDir, { recursive: true });

  const app = createApp();

  const server = app.listen(config.port, config.host, async () => {
    logger.info(`🚀 WAHA-NoWeb-Light is running on http://${config.host}:${config.port}`);
    if (config.apiKey) {
      logger.info(`🔒 API key authentication is enabled`);
    } else {
      logger.warn(`⚠️ WAHA_API_KEY is not set. All endpoints are publicly accessible!`);
    }
    if (config.webhookUrl) {
      logger.info(`📡 Default webhook configured: ${config.webhookUrl} for [${config.webhookEvents.join(', ')}]`);
    }

    // Restore sessions that were previously active
    await sessionManager.restoreExistingSessions();

    // Auto-start default session so webhook receives QR immediately without user intervention
    if (config.autoStartSession && !sessionManager.getSession(config.autoStartSession)) {
      logger.info(`⚡ Auto-starting session '${config.autoStartSession}' (webhook-first)...`);
      sessionManager.startSession(config.autoStartSession).catch((err) => {
        logger.warn(`Failed to auto-start session '${config.autoStartSession}': ${err.message}`);
      });
    }
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} received: closing HTTP server and flushing session state...`);

    try {
      await sessionManager.shutdownAll();
    } catch (err: any) {
      logger.error(`Error during session shutdown: ${err.message}`);
    }

    server.close(() => {
      logger.info('HTTP server closed successfully. Exiting process.');
      process.exit(0);
    });

    // Force exit if close takes too long
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, force exiting.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error({ err }, `Uncaught Exception: ${err.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Promise Rejection');
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, `Fatal bootstrap error: ${err.message}`);
  process.exit(1);
});

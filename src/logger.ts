import pino from 'pino';
import { config } from './config.js';

function createLogger() {
  if (config.logFormat === 'PRETTY') {
    return pino({
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino({
    level: config.logLevel,
  });
}

export const logger = createLogger();

export function createChildLogger(name: string) {
  return logger.child({ name });
}

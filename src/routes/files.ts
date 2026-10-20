import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import mime from 'mime-types';
import { config } from '../config.js';

export const filesRouter = Router();

// GET /api/files/:session/:filename
filesRouter.get('/api/files/:session/:filename', async (req: Request, res: Response) => {
  const { session, filename } = req.params;

  // Path traversal guard
  const safeSession = path.basename(session);
  const safeFilename = path.basename(filename);
  const filePath = path.join(config.mediaDir, safeSession, safeFilename);

  try {
    await fs.access(filePath);
    const mimetype = mime.lookup(safeFilename) || 'application/octet-stream';
    res.setHeader('Content-Type', mimetype);
    return res.sendFile(path.resolve(filePath));
  } catch {
    return res.status(404).json({
      statusCode: 404,
      message: `File '${filename}' not found for session '${session}'.`,
      error: 'Not Found',
    });
  }
});

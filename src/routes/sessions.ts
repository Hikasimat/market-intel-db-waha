import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';

export const sessionsRouter = Router();

// GET /api/sessions
sessionsRouter.get('/api/sessions', (req: Request, res: Response) => {
  const list = sessionManager.listSessions();
  res.json(list);
});

// GET /api/sessions/:session
sessionsRouter.get('/api/sessions/:session', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.session);
  if (!session) {
    return res.status(404).json({
      statusCode: 404,
      message: `Session '${req.params.session}' not found`,
      error: 'Not Found',
    });
  }
  res.json(session.getInfo());
});

// GET /api/sessions/:session/me
sessionsRouter.get('/api/sessions/:session/me', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.session);
  if (!session) {
    return res.status(404).json({
      statusCode: 404,
      message: `Session '${req.params.session}' not found`,
      error: 'Not Found',
    });
  }
  const me = session.getMe();
  if (!me) {
    return res.status(400).json({
      statusCode: 400,
      message: `Session '${req.params.session}' is not connected`,
      error: 'Bad Request',
    });
  }
  res.json(me);
});

// POST /api/sessions (Create and start)
sessionsRouter.post('/api/sessions', async (req: Request, res: Response, next) => {
  try {
    const name = req.body?.name || 'default';
    const info = await sessionManager.startSession(name);
    res.status(201).json(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/sessions/:session/start
sessionsRouter.post('/api/sessions/:session/start', async (req: Request, res: Response, next) => {
  try {
    const info = await sessionManager.startSession(req.params.session);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/sessions/:session/stop
sessionsRouter.post('/api/sessions/:session/stop', async (req: Request, res: Response, next) => {
  try {
    const info = await sessionManager.stopSession(req.params.session);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/sessions/:session/logout
sessionsRouter.post('/api/sessions/:session/logout', async (req: Request, res: Response, next) => {
  try {
    const info = await sessionManager.logoutSession(req.params.session);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sessions/:session
sessionsRouter.delete('/api/sessions/:session', async (req: Request, res: Response, next) => {
  try {
    await sessionManager.deleteSession(req.params.session);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

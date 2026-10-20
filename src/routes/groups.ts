import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';

export const groupsRouter = Router();

// GET /api/:session/groups
groupsRouter.get('/api/:session/groups', async (req: Request, res: Response, next) => {
  try {
    const sessionName = req.params.session;
    const session = sessionManager.getWorkingSession(sessionName);
    const groups = await session.getGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

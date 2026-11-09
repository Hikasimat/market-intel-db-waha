import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';

export const groupsRouter = Router();

function parseParticipants(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && item !== null) {
          return (item.id || item.phoneNumber || item.jid || '').trim();
        }
        return String(item).trim();
      })
      .filter(Boolean);
  }
  if (typeof input === 'string') {
    return input.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function resolveSessionName(req: Request): string {
  const param = req.params.session;
  if (param && param !== 'groups' && param !== 'default') {
    return param;
  }
  return req.body?.session || (req.query?.session as string) || param || 'default';
}

// -------------------------------------------------------------
// 1. LIST GROUPS
// -------------------------------------------------------------
// GET /api/groups
groupsRouter.get('/api/groups', async (req: Request, res: Response, next) => {
  try {
    const sessionName = resolveSessionName(req);
    const session = sessionManager.getWorkingSession(sessionName);
    const groups = await session.getGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// GET /api/:session/groups
groupsRouter.get('/api/:session/groups', async (req: Request, res: Response, next) => {
  try {
    const sessionName = resolveSessionName(req);
    const session = sessionManager.getWorkingSession(sessionName);
    const groups = await session.getGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 2. CREATE GROUP
// -------------------------------------------------------------
async function handleCreateGroup(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const name = (req.body?.name || req.body?.subject || req.body?.title || '').trim();
    const rawParticipants = req.body?.participants;
    const participants = parseParticipants(rawParticipants);

    if (!name) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing required field: "name" (or "subject") in request body.',
        error: 'Bad Request',
      });
    }

    if (!participants || participants.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing or empty "participants" list in request body. At least one participant is required.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const createdGroup = await session.createGroup(name, participants);
    res.status(201).json(createdGroup);
  } catch (err) {
    next(err);
  }
}

// POST /api/groups
groupsRouter.post('/api/groups', handleCreateGroup);

// POST /api/:session/groups
groupsRouter.post('/api/:session/groups', handleCreateGroup);

// -------------------------------------------------------------
// 3. JOIN BY INVITE CODE
// -------------------------------------------------------------
async function handleAcceptInvite(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const code = (req.body?.code || req.body?.inviteCode || '').trim();
    if (!code) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing required field: "code" in request body.',
        error: 'Bad Request',
      });
    }
    const session = sessionManager.getWorkingSession(sessionName);
    const groupId = await session.acceptGroupInvite(code);
    res.json({ success: true, groupId });
  } catch (err) {
    next(err);
  }
}

// POST /api/groups/accept-invite
groupsRouter.post('/api/groups/accept-invite', handleAcceptInvite);
// POST /api/:session/groups/accept-invite
groupsRouter.post('/api/:session/groups/accept-invite', handleAcceptInvite);

// -------------------------------------------------------------
// 4. GET GROUP METADATA
// -------------------------------------------------------------
async function handleGetGroup(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const groupId = req.params.id;
    if (!groupId) {
      return res.status(400).json({ statusCode: 400, message: 'Group ID is required.', error: 'Bad Request' });
    }
    const session = sessionManager.getWorkingSession(sessionName);
    const meta = await session.getGroup(groupId);
    res.json(meta);
  } catch (err) {
    next(err);
  }
}

// GET /api/groups/:id
groupsRouter.get('/api/groups/:id', handleGetGroup);
// GET /api/:session/groups/:id
groupsRouter.get('/api/:session/groups/:id', handleGetGroup);

// -------------------------------------------------------------
// 5. PARTICIPANT MANAGEMENT (ADD, REMOVE, PROMOTE, DEMOTE)
// -------------------------------------------------------------
function makeParticipantHandler(action: 'add' | 'remove' | 'promote' | 'demote') {
  return async (req: Request, res: Response, next: any) => {
    try {
      const sessionName = resolveSessionName(req);
      const groupId = req.params.id;
      const participants = parseParticipants(req.body?.participants);

      if (!groupId) {
        return res.status(400).json({ statusCode: 400, message: 'Group ID is required.', error: 'Bad Request' });
      }
      if (participants.length === 0) {
        return res.status(400).json({
          statusCode: 400,
          message: 'Missing or empty "participants" list in request body.',
          error: 'Bad Request',
        });
      }

      const session = sessionManager.getWorkingSession(sessionName);
      const result = await session.updateGroupParticipants(groupId, participants, action);
      res.json({ success: true, action, result });
    } catch (err) {
      next(err);
    }
  };
}

// Add participants
groupsRouter.post('/api/groups/:id/participants/add', makeParticipantHandler('add'));
groupsRouter.post('/api/:session/groups/:id/participants/add', makeParticipantHandler('add'));
// Also accept POST /api/:session/groups/:id/participants with { action: 'add' | 'remove' }
groupsRouter.post('/api/groups/:id/participants', (req, res, next) => {
  const action = req.body?.action === 'remove' ? 'remove' : req.body?.action === 'promote' ? 'promote' : req.body?.action === 'demote' ? 'demote' : 'add';
  return makeParticipantHandler(action)(req, res, next);
});
groupsRouter.post('/api/:session/groups/:id/participants', (req, res, next) => {
  const action = req.body?.action === 'remove' ? 'remove' : req.body?.action === 'promote' ? 'promote' : req.body?.action === 'demote' ? 'demote' : 'add';
  return makeParticipantHandler(action)(req, res, next);
});

// Remove participants
groupsRouter.post('/api/groups/:id/participants/remove', makeParticipantHandler('remove'));
groupsRouter.post('/api/:session/groups/:id/participants/remove', makeParticipantHandler('remove'));

// Promote to admin
groupsRouter.post('/api/groups/:id/participants/promote', makeParticipantHandler('promote'));
groupsRouter.post('/api/:session/groups/:id/participants/promote', makeParticipantHandler('promote'));

// Demote from admin
groupsRouter.post('/api/groups/:id/participants/demote', makeParticipantHandler('demote'));
groupsRouter.post('/api/:session/groups/:id/participants/demote', makeParticipantHandler('demote'));

// -------------------------------------------------------------
// 6. LEAVE GROUP
// -------------------------------------------------------------
async function handleLeaveGroup(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const groupId = req.params.id;
    if (!groupId) {
      return res.status(400).json({ statusCode: 400, message: 'Group ID is required.', error: 'Bad Request' });
    }
    const session = sessionManager.getWorkingSession(sessionName);
    await session.leaveGroup(groupId);
    res.json({ success: true, message: `Left group ${groupId}` });
  } catch (err) {
    next(err);
  }
}

groupsRouter.post('/api/groups/:id/leave', handleLeaveGroup);
groupsRouter.post('/api/:session/groups/:id/leave', handleLeaveGroup);

// -------------------------------------------------------------
// 7. UPDATE SUBJECT & DESCRIPTION
// -------------------------------------------------------------
async function handleUpdateSubject(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const groupId = req.params.id;
    const subject = (req.body?.subject || req.body?.name || '').trim();
    if (!subject) {
      return res.status(400).json({ statusCode: 400, message: 'Subject/name is required.', error: 'Bad Request' });
    }
    const session = sessionManager.getWorkingSession(sessionName);
    await session.updateGroupSubject(groupId, subject);
    res.json({ success: true, subject });
  } catch (err) {
    next(err);
  }
}

groupsRouter.post('/api/groups/:id/subject', handleUpdateSubject);
groupsRouter.put('/api/groups/:id/subject', handleUpdateSubject);
groupsRouter.post('/api/:session/groups/:id/subject', handleUpdateSubject);
groupsRouter.put('/api/:session/groups/:id/subject', handleUpdateSubject);

async function handleUpdateDescription(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const groupId = req.params.id;
    const description = (req.body?.description || req.body?.desc || '').trim();
    const session = sessionManager.getWorkingSession(sessionName);
    await session.updateGroupDescription(groupId, description);
    res.json({ success: true, description });
  } catch (err) {
    next(err);
  }
}

groupsRouter.post('/api/groups/:id/description', handleUpdateDescription);
groupsRouter.put('/api/groups/:id/description', handleUpdateDescription);
groupsRouter.post('/api/:session/groups/:id/description', handleUpdateDescription);
groupsRouter.put('/api/:session/groups/:id/description', handleUpdateDescription);

// -------------------------------------------------------------
// 8. INVITE CODE
// -------------------------------------------------------------
async function handleGetInviteCode(req: Request, res: Response, next: any) {
  try {
    const sessionName = resolveSessionName(req);
    const groupId = req.params.id;
    const session = sessionManager.getWorkingSession(sessionName);
    const invite = await session.getGroupInviteCode(groupId);
    res.json(invite);
  } catch (err) {
    next(err);
  }
}

groupsRouter.get('/api/groups/:id/invite-code', handleGetInviteCode);
groupsRouter.get('/api/:session/groups/:id/invite-code', handleGetInviteCode);

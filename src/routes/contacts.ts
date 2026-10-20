import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';

export const contactsRouter = Router();

// GET /api/contacts/check-exists
contactsRouter.get('/api/contacts/check-exists', async (req: Request, res: Response, next) => {
  try {
    const phone = req.query.phone as string;
    const sessionName = (req.query.session as string) || 'default';

    if (!phone) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "phone" query parameter.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const result = await session.checkNumberStatus(phone);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/profile-picture
contactsRouter.get('/api/contacts/profile-picture', async (req: Request, res: Response, next) => {
  try {
    const contactId = (req.query.contactId as string) || (req.query.phone as string);
    const sessionName = (req.query.session as string) || 'default';

    if (!contactId) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "contactId" or "phone" query parameter.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const url = await session.getProfilePictureUrl(contactId);

    // Return format compatible with WAHA v1, WAHA v2, and Django MarketIntel
    res.json({
      url,
      profilePictureURL: url,
      picture: url,
    });
  } catch (err) {
    next(err);
  }
});


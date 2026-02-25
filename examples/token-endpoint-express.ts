import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const router = express.Router();

const CHAT_JWT_SECRET = process.env.CHAT_JWT_SECRET || '';
const CHAT_SITE = process.env.CHAT_SITE || 'app.example.com';

if (!CHAT_JWT_SECRET) {
  throw new Error('CHAT_JWT_SECRET is required');
}

function requireUser(req: express.Request): {
  id: string;
  email?: string;
  name?: string;
} {
  // Replace this with your own auth/session middleware integration.
  const user = (req as express.Request & { user?: { id?: string; email?: string; name?: string } }).user;
  if (!user?.id) {
    throw new Error('Unauthorized');
  }
  return user as { id: string; email?: string; name?: string };
}

router.post('/api/widget-token', (req, res) => {
  try {
    const user = requireUser(req);

    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) {
      return res.status(400).json({ error: 'Missing Origin header' });
    }

    const token = jwt.sign(
      {
        sub: user.id,
        jti: randomUUID(),
        site: CHAT_SITE,
        origin,
        email: user.email,
        name: user.name,
      },
      CHAT_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '10m' },
    );

    return res.json({ token });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
});

export default router;

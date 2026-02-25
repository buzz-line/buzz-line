import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dns from 'dns/promises';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import type TelegramBot from 'node-telegram-bot-api';
import { getSupportPresenceState, getTokenSession, getVisitor, stmts } from './db';
import * as telegram from './telegram';
import type { ChatMessage, SupportPresenceState, TokenClaims, VisitorAuthType, VisitorRecord } from './types';

declare global {
  namespace Express {
    interface Request {
      jwtClaims?: TokenClaims;
    }
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_NAME = process.env.SITE_NAME || 'default';
const JWT_SECRET = process.env.JWT_SECRET || '';
const AUTH_REQUIRED = true;
const ANONYMOUS_ALLOWED = process.env.ANONYMOUS_ALLOWED !== 'false';
const ANON_TOKEN_TTL_SECONDS = 900;
const ANON_EMAIL_REQUIRED = process.env.ANON_EMAIL_REQUIRED === 'true';
const ANON_VISITOR_ID_RE = /^anon-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
const TELEGRAM_MODE_RAW = (process.env.TELEGRAM_MODE || '').trim().toLowerCase();
const TELEGRAM_MODE: telegram.TelegramMode = TELEGRAM_MODE_RAW === 'polling'
  ? 'polling'
  : TELEGRAM_MODE_RAW === 'webhook'
    ? 'webhook'
    : IS_DEVELOPMENT
      ? 'polling'
      : 'webhook';
const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/api/telegram/webhook';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL
  ? process.env.TELEGRAM_WEBHOOK_URL.trim()
  : '';
const DEV_TOKEN_ENDPOINT_FLAG = process.env.ENABLE_DEV_TOKEN_ENDPOINT === 'true';
if (DEV_TOKEN_ENDPOINT_FLAG && !IS_DEVELOPMENT) {
  throw new Error('ENABLE_DEV_TOKEN_ENDPOINT=true is only allowed when NODE_ENV=development');
}
const ENABLE_DEV_TOKEN_ENDPOINT = IS_DEVELOPMENT && DEV_TOKEN_ENDPOINT_FLAG;
const DEV_TOKEN_TTL_SECONDS = Math.min(
  Math.max(Number(process.env.DEV_TOKEN_TTL_SECONDS || 300), 30),
  3600,
);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured');
}

if (TELEGRAM_MODE_RAW && TELEGRAM_MODE_RAW !== 'polling' && TELEGRAM_MODE_RAW !== 'webhook') {
  throw new Error('TELEGRAM_MODE must be either "polling" or "webhook"');
}

if (ALLOWED_ORIGINS.length === 0) {
  throw new Error('ALLOWED_ORIGINS must include at least one origin');
}

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WIDGET_DIR = path.join(ROOT_DIR, 'widget');
const uploadsDir = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

let maintenanceInterval: NodeJS.Timeout | null = null;
let telegramInitialized = false;

wss.on('error', (error) => {
  console.error('[WS] Server error:', error.message);
});

function toHost(input: unknown): string | null {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    const cleaned = raw
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    return cleaned || null;
  }
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(':')[0]?.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLoopbackAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized === '::ffff:127.0.0.1'
  );
}

const allowedOriginHosts = new Set(ALLOWED_ORIGINS.map((origin) => toHost(origin)).filter(Boolean) as string[]);

if (allowedOriginHosts.size === 0) {
  throw new Error('ALLOWED_ORIGINS contains no valid origins');
}

function originHost(origin: unknown): string | null {
  if (!origin || typeof origin !== 'string') return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: unknown): boolean {
  const host = originHost(origin);
  return Boolean(host && allowedOriginHosts.has(host));
}

function tokenSiteHost(siteClaim: unknown): string | null {
  return toHost(siteClaim);
}

function getOriginHeader(req: Request | http.IncomingMessage): string {
  const header = req.headers.origin;
  if (Array.isArray(header)) return header[0] || '';
  return header || '';
}

function getIp(req: Request | http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedIp = headerValue?.split(',')[0]?.trim();

  if (forwardedIp) return forwardedIp;
  if ('socket' in req && req.socket?.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function isTokenClaims(value: unknown): value is TokenClaims {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Partial<TokenClaims>;

  return (
    typeof obj.sub === 'string'
    && typeof obj.jti === 'string'
    && typeof obj.exp === 'number'
  );
}

function validateTokenSession(claims: TokenClaims, requestOriginHost: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const jti = claims.jti.trim();
  const sub = claims.sub.trim();
  const exp = Number(claims.exp);

  if (!jti || !sub || !Number.isFinite(exp) || exp <= now) return false;

  const claimOriginHost = toHost(claims.origin);
  const claimSite = tokenSiteHost(claims.site);

  if (claimOriginHost && claimOriginHost !== requestOriginHost) return false;
  if (claimSite && claimSite !== requestOriginHost) return false;

  const existing = getTokenSession(jti);

  if (!existing) {
    try {
      stmts.insertTokenSession.run(jti, sub, claimSite || requestOriginHost, requestOriginHost, exp);
      return true;
    } catch {
      return false;
    }
  }

  if (existing.revoked_at) return false;
  if (existing.sub !== sub) return false;
  if (Number(existing.expires_at) < now) return false;
  if (existing.origin_host && existing.origin_host !== requestOriginHost) return false;
  if (existing.site && claimSite && existing.site !== claimSite) return false;

  try {
    stmts.touchTokenSession.run(jti);
  } catch {
    return false;
  }

  return true;
}

function verifyToken(token: string, origin: string): TokenClaims | null {
  if (!token) return null;

  const requestOriginHost = originHost(origin);
  if (!requestOriginHost) return null;
  if (!allowedOriginHosts.has(requestOriginHost)) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!isTokenClaims(decoded)) return null;
    if (!validateTokenSession(decoded, requestOriginHost)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): Response | void {
  if (!AUTH_REQUIRED) {
    return res.status(500).json({ error: 'Auth misconfiguration' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const origin = getOriginHeader(req);
  const claims = verifyToken(token, origin);

  if (!claims) {
    return res.status(401).json({ error: 'Valid authentication required' });
  }

  req.jwtClaims = claims;
  next();
}

function resolveVisitorId(req: Request, requestedVisitorId: unknown): { visitorId?: string; error?: string; status?: number } {
  const sub = req.jwtClaims?.sub;
  if (!sub || typeof sub !== 'string') return { error: 'Invalid token subject', status: 401 };

  const visitorParam = Array.isArray(requestedVisitorId) ? requestedVisitorId[0] : requestedVisitorId;
  if (typeof visitorParam !== 'string' || visitorParam.length === 0) {
    return { error: 'Invalid visitor id', status: 400 };
  }

  if (visitorParam !== sub) return { error: 'Forbidden visitor access', status: 403 };
  return { visitorId: sub };
}

function siteFromClaims(claims: TokenClaims | undefined, fallback = SITE_NAME): string {
  const host = tokenSiteHost(claims?.site);
  return host || fallback;
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/widget', express.static(WIDGET_DIR));

const rateLimits = new Map<string, { short: number[]; medium: number[]; daily: number[]; burstStrikes: number; blockedUntil: number }>();

const RATE_SHORT_MAX = 5;
const RATE_SHORT_WINDOW = 10000;
const RATE_MEDIUM_MAX = 60;
const RATE_MEDIUM_WINDOW = 600000;
const RATE_DAILY_MAX = 300;
const RATE_DAILY_WINDOW = 86400000;
const BURST_COOLDOWN = 60000;
const BURST_STRIKE_THRESHOLD = 3;
const MAX_MESSAGE_LENGTH = 2000;

function getRateEntry(key: string) {
  if (!rateLimits.has(key)) {
    rateLimits.set(key, { short: [], medium: [], daily: [], burstStrikes: 0, blockedUntil: 0 });
  }
  return rateLimits.get(key)!;
}

function pruneEntry(entry: { short: number[]; medium: number[]; daily: number[] }, now: number) {
  entry.short = entry.short.filter((t) => now - t < RATE_SHORT_WINDOW);
  entry.medium = entry.medium.filter((t) => now - t < RATE_MEDIUM_WINDOW);
  entry.daily = entry.daily.filter((t) => now - t < RATE_DAILY_WINDOW);
}

function checkRateLimitKeys(keys: string[]): boolean {
  const now = Date.now();
  const entries = keys.map((key) => [key, getRateEntry(key)] as const);

  for (const [, entry] of entries) {
    pruneEntry(entry, now);
    if (entry.blockedUntil > now) return false;

    if (entry.short.length >= RATE_SHORT_MAX) {
      entry.burstStrikes += 1;
      if (entry.burstStrikes >= BURST_STRIKE_THRESHOLD) {
        entry.blockedUntil = now + BURST_COOLDOWN;
        entry.burstStrikes = 0;
      }
      return false;
    }

    if (entry.medium.length >= RATE_MEDIUM_MAX) return false;
    if (entry.daily.length >= RATE_DAILY_MAX) return false;
  }

  for (const [, entry] of entries) {
    entry.short.push(now);
    entry.medium.push(now);
    entry.daily.push(now);
  }

  return true;
}

function isAnonClaims(claims: TokenClaims | undefined): boolean {
  return claims?.anon === true || (typeof claims?.sub === 'string' && claims.sub.startsWith('anon-'));
}

function authTypeFromClaims(claims: TokenClaims | undefined): VisitorAuthType {
  return isAnonClaims(claims) ? 'anonymous' : 'authenticated';
}

function rateLimitKeys(claims: TokenClaims | undefined, ip: string): string[] {
  const site = siteFromClaims(claims, 'unknown');
  const cleanIp = (ip || 'unknown').toLowerCase();
  if (isAnonClaims(claims)) {
    return [`site:${site}:ip:${cleanIp}`];
  }
  const sub = claims?.sub || 'unknown';
  return [`site:${site}:user:${sub}`, `site:${site}:ip:${cleanIp}`];
}

function maintenanceTick(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    pruneEntry(entry, now);
    if (entry.short.length === 0 && entry.medium.length === 0 && entry.daily.length === 0 && entry.blockedUntil < now) {
      rateLimits.delete(key);
    }
  }

  try {
    stmts.purgeExpiredTokenSessions.run(Math.floor(Date.now() / 1000));
  } catch {
    // Best-effort cleanup
  }
}

function startMaintenanceLoop(): void {
  if (maintenanceInterval) return;
  maintenanceInterval = setInterval(maintenanceTick, 60000);
}

function stopMaintenanceLoop(): void {
  if (!maintenanceInterval) return;
  clearInterval(maintenanceInterval);
  maintenanceInterval = null;
}

const clients = new Map<string, Set<WebSocket>>();

function buildSupportPresencePayload(state: SupportPresenceState = getSupportPresenceState()): { state: SupportPresenceState; updatedAt: string } {
  return {
    state,
    updatedAt: new Date().toISOString(),
  };
}

function broadcastToVisitor(visitorId: string, message: { type: string; message?: ChatMessage }): void {
  const sockets = clients.get(visitorId);
  if (!sockets) return;

  const data = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function broadcastSupportPresence(state: SupportPresenceState): void {
  const payload = JSON.stringify({ type: 'presence', presence: buildSupportPresencePayload(state) });
  for (const sockets of clients.values()) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

const typingThrottle = new Map<string, number>();

interface WsAuthMessage {
  type: 'auth';
  token: string;
}

interface WsInitMessage {
  type: 'init';
  visitorId?: string | null;
  site?: string;
}

interface WsTypingMessage {
  type: 'typing';
}

interface WsUserMessage {
  type: 'message';
  content: string;
}

type WsIncomingMessage = WsAuthMessage | WsInitMessage | WsTypingMessage | WsUserMessage;

function parseWsMessage(raw: RawData): WsIncomingMessage {
  let text: string;

  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString('utf8');
  } else {
    text = Buffer.from(raw).toString('utf8');
  }

  return JSON.parse(text) as WsIncomingMessage;
}

wss.on('connection', (ws, req) => {
  let visitorId: string | null = null;
  let claims: TokenClaims | null = null;
  let rlKeys: string[] = [];
  let authenticated = false;

  const origin = getOriginHeader(req);
  const ip = getIp(req);
  const authTimeout = setTimeout(() => {
    if (!authenticated) ws.close(4001, 'Authentication required');
  }, 5000);

  ws.on('message', (raw) => {
    try {
      const msg = parseWsMessage(raw);

      if (!authenticated) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string') {
          ws.close(4001, 'Authentication required');
          return;
        }

        const verified = verifyToken(msg.token, origin);
        if (!verified) {
          ws.close(4001, 'Authentication required');
          return;
        }

        claims = verified;
        rlKeys = rateLimitKeys(claims, ip);
        authenticated = true;
        clearTimeout(authTimeout);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        return;
      }

      if (!claims) {
        ws.close(4001, 'Authentication required');
        return;
      }

      if (msg.type === 'init') {
        visitorId = claims.sub;
        const name = claims.name || null;
        const email = claims.email || null;
        const site = siteFromClaims(claims);

        stmts.upsertVisitor.run(visitorId, name, site, email, authTypeFromClaims(claims));

        if (!clients.has(visitorId)) clients.set(visitorId, new Set());
        clients.get(visitorId)!.add(ws);

        ws.send(JSON.stringify({ type: 'init', visitorId }));
        ws.send(JSON.stringify({ type: 'presence', presence: buildSupportPresencePayload() }));
        return;
      }

      if (msg.type === 'typing' && visitorId) {
        const now = Date.now();
        const last = typingThrottle.get(visitorId) || 0;
        if (now - last > 5000) {
          typingThrottle.set(visitorId, now);
          telegram.sendTypingToTopic(visitorId);
        }
        return;
      }

      if (msg.type === 'message' && visitorId) {
        const content = msg.content;

        if (typeof content !== 'string' || content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message length (1-2000 chars)' }));
          return;
        }

        if (!checkRateLimitKeys(rlKeys)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many messages, slow down' }));
          return;
        }

        const result = stmts.addMessage.run(visitorId, 'visitor', content, 'text', null);

        const outMsg: ChatMessage = {
          id: Number(result.lastInsertRowid),
          visitor_id: visitorId,
          sender: 'visitor',
          content,
          type: 'text',
          file_url: null,
          created_at: new Date().toISOString(),
        };

        broadcastToVisitor(visitorId, { type: 'message', message: outMsg });

        const visitor = getVisitor(visitorId);
        telegram.sendToTopic(visitorId, content, 'text', visitor?.site || SITE_NAME);
      }
    } catch (err) {
      const error = err as Error;
      console.error('[WS] Error:', error.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (visitorId && clients.has(visitorId)) {
      clients.get(visitorId)!.delete(ws);
      if (clients.get(visitorId)!.size === 0) clients.delete(visitorId);
    }
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  if (process.env.DISABLE_TELEGRAM === 'true') {
    return res.status(503).json({ error: 'Telegram integration disabled' });
  }
  if (TELEGRAM_MODE !== 'webhook') {
    return res.status(409).json({ error: 'Telegram webhook is disabled in polling mode' });
  }

  if (TELEGRAM_WEBHOOK_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    const incomingSecret = Array.isArray(header) ? header[0] : header;
    if (incomingSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
    }
  }

  const update = req.body as { update_id?: unknown } | undefined;
  if (!update || typeof update.update_id !== 'number') {
    return res.status(400).json({ error: 'Invalid Telegram update payload' });
  }

  const accepted = telegram.processWebhookUpdate(update as TelegramBot.Update);
  if (!accepted) {
    return res.status(503).json({ error: 'Telegram webhook not initialized' });
  }

  return res.status(200).json({ ok: true });
});

if (ENABLE_DEV_TOKEN_ENDPOINT) {
  app.post('/api/dev/token', (req, res) => {
    const origin = getOriginHeader(req);
    const requestOriginHost = originHost(origin);
    const remoteAddress = req.socket.remoteAddress || null;

    // Dev token minting is only for explicit local development use.
    if (!isLoopbackAddress(remoteAddress) || !isLoopbackHost(requestOriginHost)) {
      return res.status(403).json({ error: 'Dev token endpoint only accepts localhost requests' });
    }
    if (!isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    if (!requestOriginHost) {
      return res.status(400).json({ error: 'Missing valid Origin header' });
    }

    const body = req.body as {
      sub?: unknown;
      email?: unknown;
      name?: unknown;
      site?: unknown;
      origin?: unknown;
    };

    const sub = typeof body?.sub === 'string' && body.sub.trim()
      ? body.sub.trim()
      : `dev-user-${uuidv4().slice(0, 8)}`;
    const email = typeof body?.email === 'string' ? body.email : `${sub}@localhost`;
    const name = typeof body?.name === 'string' ? body.name : 'Local Dev User';
    const site = typeof body?.site === 'string' ? body.site : requestOriginHost;
    const tokenOrigin = typeof body?.origin === 'string' ? body.origin : origin;

    const token = jwt.sign(
      {
        sub,
        email,
        name,
        site,
        origin: tokenOrigin,
        jti: uuidv4(),
      },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: DEV_TOKEN_TTL_SECONDS },
    );

    return res.json({ token, expiresIn: DEV_TOKEN_TTL_SECONDS, sub });
  });
}

if (ANONYMOUS_ALLOWED) {
  app.post('/api/auth/anonymous', async (req, res) => {
    const origin = getOriginHeader(req);
    const requestOriginHost = originHost(origin);
    if (!requestOriginHost || !allowedOriginHosts.has(requestOriginHost)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    const ip = getIp(req);
    const anonRlKey = `anon-token:ip:${ip}`;
    if (!checkRateLimitKeys([anonRlKey])) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const body = req.body as { visitorId?: unknown; email?: unknown; name?: unknown };

    let sub: string;
    const clientVisitorId = typeof body?.visitorId === 'string' ? body.visitorId.trim() : '';
    if (clientVisitorId && ANON_VISITOR_ID_RE.test(clientVisitorId)) {
      sub = clientVisitorId;
    } else {
      sub = `anon-${uuidv4()}`;
    }

    const email = typeof body?.email === 'string' && body.email.includes('@')
      ? body.email.trim().slice(0, 254)
      : null;
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : null;

    if (ANON_EMAIL_REQUIRED && !email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (email) {
      const domain = email.split('@')[1];
      try {
        const records = await dns.resolveMx(domain);
        if (!records || records.length === 0) {
          return res.status(400).json({ error: 'Invalid email domain' });
        }
      } catch {
        return res.status(400).json({ error: 'Invalid email domain' });
      }
    }

    const jti = uuidv4();
    const token = jwt.sign(
      {
        sub,
        jti,
        site: requestOriginHost,
        origin,
        email,
        name,
        anon: true,
      },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: ANON_TOKEN_TTL_SECONDS },
    );

    return res.json({ token, visitorId: sub, expiresIn: ANON_TOKEN_TTL_SECONDS });
  });
}

app.post('/api/auth/revoke', requireAuth, (req, res) => {
  const jti = req.jwtClaims?.jti;
  const sub = req.jwtClaims?.sub;

  if (!jti || !sub) {
    return res.status(400).json({ error: 'Invalid token claims' });
  }

  stmts.revokeTokenSession.run(jti);

  const sockets = clients.get(sub);
  if (sockets) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(4001, 'Session revoked');
      }
    }
    clients.delete(sub);
  }

  return res.json({ revoked: true });
});

app.get('/api/chat/:visitorId/history', requireAuth, (req, res) => {
  try {
    const resolved = resolveVisitorId(req, req.params.visitorId);
    if (resolved.error || !resolved.visitorId) return res.status(resolved.status || 400).json({ error: resolved.error || 'Bad request' });

    const messages = stmts.getHistory.all(resolved.visitorId);
    return res.json({ messages });
  } catch (err) {
    const error = err as Error;
    return res.status(500).json({ error: error.message });
  }
});

const uploadParser = express.raw({ type: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], limit: '5mb' });

app.post('/api/chat/:visitorId/upload', requireAuth, uploadParser, async (req, res) => {
  try {
    const resolved = resolveVisitorId(req, req.params.visitorId);
    if (resolved.error || !resolved.visitorId) return res.status(resolved.status || 400).json({ error: resolved.error || 'Bad request' });
    const visitorId = resolved.visitorId;

    const claims = req.jwtClaims;
    const ip = getIp(req);
    const keys = rateLimitKeys(claims, ip);

    const visitor = getVisitor(visitorId);
    if (!visitor) {
      const name = claims?.name || null;
      const email = claims?.email || null;
      const site = siteFromClaims(claims);
      stmts.upsertVisitor.run(visitorId, name, site, email, authTypeFromClaims(claims));
    }

    if (!checkRateLimitKeys(keys)) {
      return res.status(429).json({ error: 'Too many messages, slow down' });
    }

    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      return res.status(400).json({ error: 'Image body required' });
    }

    const buffer = rawBody;

    let ext: '.jpg' | '.png' | '.gif' | '.webp' | null = null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) ext = '.jpg';
    else if (buffer[0] === 0x89 && buffer[1] === 0x50) ext = '.png';
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) ext = '.gif';
    else if (
      buffer.length >= 12
      && buffer[0] === 0x52 && buffer[1] === 0x49
      && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45
      && buffer[10] === 0x42 && buffer[11] === 0x50
    ) ext = '.webp';

    if (!ext) return res.status(400).json({ error: 'Unsupported image format (jpg, png, gif, webp only)' });

    const head = buffer.slice(0, 256).toString('utf8').toLowerCase();
    if (head.includes('<svg') || head.includes('<?xml')) {
      return res.status(400).json({ error: 'SVG uploads are not allowed' });
    }

    let processedBuffer: Buffer;
    try {
      if (ext === '.gif') {
        processedBuffer = buffer;
      } else {
        processedBuffer = await sharp(buffer).rotate().toBuffer();
      }
    } catch {
      processedBuffer = buffer;
    }

    const filename = `${Date.now()}-${uuidv4()}${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, processedBuffer);

    const fileUrl = `/uploads/${filename}`;
    const result = stmts.addMessage.run(visitorId, 'visitor', fileUrl, 'image', fileUrl);

    const message: ChatMessage = {
      id: Number(result.lastInsertRowid),
      visitor_id: visitorId,
      sender: 'visitor',
      content: fileUrl,
      type: 'image',
      file_url: fileUrl,
      created_at: new Date().toISOString(),
    };

    broadcastToVisitor(visitorId, { type: 'message', message });

    const latestVisitor = getVisitor(visitorId);
    const site = latestVisitor?.site || siteFromClaims(claims);
    telegram.sendToTopic(visitorId, fileUrl, 'image', site, fileUrl);

    return res.json({ message });
  } catch (err) {
    const maybeErr = err as { type?: string; message?: string };
    return res.status(500).json({ error: maybeErr.message || 'Internal server error' });
  }
});

app.post('/api/chat/:visitorId/message', requireAuth, (req, res) => {
  try {
    const resolved = resolveVisitorId(req, req.params.visitorId);
    if (resolved.error || !resolved.visitorId) return res.status(resolved.status || 400).json({ error: resolved.error || 'Bad request' });
    const visitorId = resolved.visitorId;

    const body = req.body as { content?: unknown };
    const content = body.content;

    const claims = req.jwtClaims;
    const ip = getIp(req);
    const keys = rateLimitKeys(claims, ip);

    if (typeof content !== 'string' || content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: 'Invalid message length (1-2000 chars)' });
    }

    if (!checkRateLimitKeys(keys)) {
      return res.status(429).json({ error: 'Too many messages, slow down' });
    }

    stmts.upsertVisitor.run(visitorId, claims?.name || null, siteFromClaims(claims), claims?.email || null, authTypeFromClaims(claims));

    const result = stmts.addMessage.run(visitorId, 'visitor', content, 'text', null);

    const message: ChatMessage = {
      id: Number(result.lastInsertRowid),
      visitor_id: visitorId,
      sender: 'visitor',
      content,
      type: 'text',
      file_url: null,
      created_at: new Date().toISOString(),
    };

    broadcastToVisitor(visitorId, { type: 'message', message });
    const visitor = getVisitor(visitorId);
    telegram.sendToTopic(visitorId, content, 'text', visitor?.site || SITE_NAME);

    return res.json({ message });
  } catch (err) {
    const error = err as Error;
    return res.status(500).json({ error: error.message });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;

  const maybeErr = err as { type?: string; status?: number; statusCode?: number; message?: string };
  const status = maybeErr.statusCode || maybeErr.status;

  if (maybeErr?.type === 'entity.too.large') {
    res.status(413).json({ error: 'File too large (max 5MB)' });
    return;
  }

  if (status === 413) {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  if (status === 415) {
    res.status(415).json({ error: 'Unsupported media type' });
    return;
  }

  if (maybeErr?.message === 'Origin not allowed') {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  if (maybeErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  res.status(500).json({ error: maybeErr?.message || 'Internal server error' });
});

async function initTelegram(): Promise<void> {
  if (telegramInitialized || process.env.DISABLE_TELEGRAM === 'true') return;
  if (IS_DEVELOPMENT && !TELEGRAM_MODE_RAW) {
    console.log('[Server] Telegram disabled in development (set TELEGRAM_MODE=polling to enable)');
    return;
  }
  await telegram.init({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatGroupId: process.env.TELEGRAM_GROUP_ID ? Number(process.env.TELEGRAM_GROUP_ID) : null,
    mode: TELEGRAM_MODE,
    webhookSecret: TELEGRAM_WEBHOOK_SECRET,
    webhookUrl: TELEGRAM_WEBHOOK_URL,
    broadcastFn: (visitorId, message) => broadcastToVisitor(visitorId, { type: 'message', message }),
    onPresenceChange: (state) => broadcastSupportPresence(state),
  });
  telegramInitialized = true;
}

async function stopServer(): Promise<void> {
  stopMaintenanceLoop();
  await telegram.shutdown();
  telegramInitialized = false;

  for (const socket of wss.clients) {
    socket.close(1001, 'Server shutting down');
  }

  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });

  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startServer(port: number = PORT, host: string = HOST): Promise<http.Server> {
  if (server.listening) return server;

  await initTelegram();
  startMaintenanceLoop();

  const listenPort = Number.isFinite(port) ? port : 3000;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(listenPort, host);
    });
  } catch (error) {
    stopMaintenanceLoop();
    await telegram.shutdown();
    telegramInitialized = false;
    throw error;
  }

  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : listenPort;
  console.log(`[Server] Live chat running on ${host}:${activePort}`);
  console.log(`[Server] Auth required: ${AUTH_REQUIRED}`);
  console.log(`[Server] Telegram mode: ${TELEGRAM_MODE}`);
  if (TELEGRAM_MODE === 'webhook') {
    console.log(`[Server] Telegram webhook path: ${TELEGRAM_WEBHOOK_PATH}`);
  }
  console.log(`[Server] Allowed origin hosts: ${Array.from(allowedOriginHosts).join(', ')}`);
  console.log(`[Server] Anonymous sessions: ${ANONYMOUS_ALLOWED ? 'enabled' : 'disabled'}${ANON_EMAIL_REQUIRED ? ' (email required)' : ''}`);
  console.log(`[Server] Dev token endpoint: ${ENABLE_DEV_TOKEN_ENDPOINT ? 'enabled' : 'disabled'}`);
  return server;
}

export { app, server, startServer, stopServer };

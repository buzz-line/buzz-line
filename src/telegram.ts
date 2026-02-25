import TelegramBot, { Message } from 'node-telegram-bot-api';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getSupportPresenceState, setSupportPresenceState, stmts } from './db';
import type { ChatMessage, SupportPresenceState, VisitorRecord } from './types';

type TelegramMode = 'polling' | 'webhook';

interface InitOptions {
  token?: string;
  chatGroupId: number | null;
  mode: TelegramMode;
  webhookUrl?: string;
  webhookSecret?: string;
  broadcastFn: (visitorId: string, message: ChatMessage) => void;
  onPresenceChange?: (state: SupportPresenceState, updatedAt: string) => void;
}

let bot: TelegramBot | null = null;
let groupId: number | null = null;
let wsBroadcast: ((visitorId: string, message: ChatMessage) => void) | null = null;
let presenceChangeHook: ((state: SupportPresenceState, updatedAt: string) => void) | null = null;
let activeMode: TelegramMode | null = null;

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

function resolvePublicFilePath(fileUrl: string | null | undefined): string | null {
  if (typeof fileUrl !== 'string' || fileUrl.length === 0) return null;

  const relative = fileUrl.replace(/^\/+/, '');
  if (relative.includes('..')) return null;

  const filePath = path.join(PUBLIC_DIR, relative);
  const normalizedBase = `${path.join(PUBLIC_DIR)}${path.sep}`;
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(normalizedBase)) return null;
  return normalizedPath;
}

function requireMediaFilePath(fileUrl: string): string {
  const filePath = resolvePublicFilePath(fileUrl);
  if (!filePath) {
    throw new Error('Invalid media path');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('Media file not found on disk');
  }
  return filePath;
}

function isMissingThreadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { message?: unknown };
  if (typeof maybeError.message !== 'string') return false;
  return maybeError.message.toLowerCase().includes('message thread not found');
}

function clearVisitorTopic(visitorId: string): void {
  stmts.setTopicId.run(null, visitorId);
}

function registerMessageHandler(): void {
  if (!bot) return;

  bot.on('message', async (msg: Message) => {
    try {
      if (await handleSupportCommand(msg)) return;

      if (!msg.message_thread_id) return;
      if (msg.from?.is_bot) return;

      const visitor = stmts.getVisitorByTopic.get(msg.message_thread_id) as VisitorRecord | undefined;
      if (!visitor) return;

      const inbound = await mapTelegramInboundMessage(msg);
      if (!inbound) return;

      const result = stmts.addMessage.run(visitor.id, 'agent', inbound.content, inbound.type, inbound.fileUrl);

      if (wsBroadcast) {
        wsBroadcast(visitor.id, {
          id: Number(result.lastInsertRowid),
          visitor_id: visitor.id,
          sender: 'agent',
          content: inbound.content,
          type: inbound.type,
          file_url: inbound.fileUrl,
          created_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      const error = err as Error;
      console.error('[Telegram] Error handling message:', error.message);
    }
  });
}

function normalizePresenceCommandState(command: string): SupportPresenceState | null {
  if (command === '/support_online') return 'online';
  if (command === '/support_offline') return 'offline';
  return null;
}

function normalizeCommand(text: string): string {
  const first = text.trim().split(/\s+/, 1)[0] || '';
  return first.toLowerCase().replace(/@.+$/, '');
}

async function handleSupportCommand(msg: Message): Promise<boolean> {
  if (!bot || !groupId) return false;
  if (msg.from?.is_bot) return false;
  if (msg.chat.id !== groupId) return false;
  if (typeof msg.text !== 'string') return false;

  const command = normalizeCommand(msg.text);
  if (!command.startsWith('/support_')) return false;

  if (command === '/support_status') {
    const state = getSupportPresenceState();
    await bot.sendMessage(groupId, `Support presence is currently: ${state}`, {
      message_thread_id: msg.message_thread_id,
    });
    return true;
  }

  const nextState = normalizePresenceCommandState(command);
  if (!nextState) {
    await bot.sendMessage(groupId, 'Unknown support command. Use /support_online, /support_offline, or /support_status.', {
      message_thread_id: msg.message_thread_id,
    });
    return true;
  }

  setSupportPresenceState(nextState);
  const updatedAt = new Date().toISOString();
  if (presenceChangeHook) {
    presenceChangeHook(nextState, updatedAt);
  }

  await bot.sendMessage(groupId, `Support presence set to: ${nextState}`, {
    message_thread_id: msg.message_thread_id,
  });
  return true;
}

async function init(options: InitOptions): Promise<TelegramBot | null> {
  const {
    token,
    chatGroupId,
    mode,
    webhookUrl,
    webhookSecret,
    broadcastFn,
    onPresenceChange,
  } = options;

  groupId = chatGroupId;
  wsBroadcast = broadcastFn;
  presenceChangeHook = onPresenceChange || null;
  activeMode = mode;

  if (!token) {
    console.warn('[Telegram] No bot token provided, running without Telegram integration');
    return null;
  }

  bot = new TelegramBot(token, { polling: false });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });

  bot.on('webhook_error', (err) => {
    console.error('[Telegram] Webhook error:', err.message);
  });

  registerMessageHandler();

  if (chatGroupId) {
    await bot.setMyCommands([
      { command: 'support_online', description: 'Set support status to online' },
      { command: 'support_offline', description: 'Set support status to offline' },
      { command: 'support_status', description: 'Check current support status' },
    ], { scope: { type: 'chat', chat_id: chatGroupId } });
  }

  if (mode === 'polling') {
    await bot.startPolling({ restart: true });
    console.log('[Telegram] Bot started with polling');
    return bot;
  }

  const trimmedWebhookUrl = webhookUrl?.trim();
  if (!trimmedWebhookUrl) {
    throw new Error('TELEGRAM_WEBHOOK_URL must be configured when TELEGRAM_MODE=webhook');
  }
  if (!/^https:\/\//i.test(trimmedWebhookUrl)) {
    throw new Error('TELEGRAM_WEBHOOK_URL must use https://');
  }

  await bot.setWebHook(trimmedWebhookUrl, {
    allowed_updates: ['message'],
    secret_token: webhookSecret || undefined,
  });

  console.log(`[Telegram] Bot started with webhook (${trimmedWebhookUrl})`);
  return bot;
}

function processWebhookUpdate(update: TelegramBot.Update): boolean {
  if (!bot || activeMode !== 'webhook') return false;
  bot.processUpdate(update);
  return true;
}

async function mapTelegramInboundMessage(
  msg: Message,
): Promise<{ content: string; type: 'text' | 'image' | 'file'; fileUrl: string | null } | null> {
  let content = msg.text || '';
  let type: 'text' | 'image' | 'file' = 'text';
  let fileUrl: string | null = null;

  if (msg.photo && msg.photo.length > 0 && bot) {
    const photo = msg.photo[msg.photo.length - 1];
    const telegramUrl = await bot.getFileLink(photo.file_id);
    const localPath = await downloadFile(telegramUrl, `${photo.file_id}.jpg`);
    content = `/uploads/${path.basename(localPath)}`;
    fileUrl = content;
    type = 'image';
    if (msg.caption) content = msg.caption;
  }

  if (msg.document && bot) {
    const telegramUrl = await bot.getFileLink(msg.document.file_id);
    const ext = path.extname(msg.document.file_name || '') || '';
    const localPath = await downloadFile(telegramUrl, `${msg.document.file_id}${ext}`);
    content = `/uploads/${path.basename(localPath)}`;
    fileUrl = content;
    type = msg.document.mime_type?.startsWith('image/') ? 'image' : 'file';
  }

  if (!content && !fileUrl) return null;
  return { content, type, fileUrl };
}

function downloadFile(url: string, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    const safeName = path.basename(filename);
    const filePath = path.join(UPLOADS_DIR, safeName);
    const file = fs.createWriteStream(filePath);
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlink(filePath, () => {});
          downloadFile(response.headers.location, safeName).then(resolve).catch(reject);
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(filePath);
        });
      })
      .on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
  });
}

async function createTopicForVisitor(visitorId: string, siteName: string): Promise<number | null> {
  if (!bot || !groupId) return null;

  try {
    const visitor = stmts.getVisitor.get(visitorId) as VisitorRecord | undefined;
    if (visitor?.telegram_topic_id) return visitor.telegram_topic_id;

    const countRecord = stmts.getVisitorCount.get() as { count: number };

    const isAnon = visitor?.auth_type === 'anonymous';
    const prefix = isAnon ? '[Anon] ' : '';

    let topicName: string;
    if (visitor?.name && visitor?.email) {
      topicName = `${prefix}${visitor.name} (${visitor.email}) from ${siteName || 'unknown'}`;
    } else if (visitor?.email) {
      topicName = `${prefix}${visitor.email} from ${siteName || 'unknown'}`;
    } else if (visitor?.name) {
      topicName = `${prefix}${visitor.name} from ${siteName || 'unknown'}`;
    } else {
      topicName = `${prefix}Visitor #${countRecord.count} from ${siteName || 'unknown'}`;
    }

    const result = await bot.createForumTopic(groupId, topicName);
    const topicId = (result as unknown as { message_thread_id?: unknown }).message_thread_id;
    if (typeof topicId !== 'number') return null;

    stmts.setTopicId.run(topicId, visitorId);
    return topicId;
  } catch (err) {
    const error = err as Error;
    console.error('[Telegram] Error creating topic:', error.message);
    return null;
  }
}

async function sendToTopic(
  visitorId: string,
  content: string,
  type: 'text' | 'image' | 'file' = 'text',
  siteName: string,
  fileUrl?: string | null,
): Promise<void> {
  if (!bot || !groupId) return;

  async function sendToTopicId(topicId: number): Promise<void> {
    if (!bot || !groupId) return;
    if (type === 'image' && fileUrl) {
      const filePath = requireMediaFilePath(fileUrl);
      await bot.sendPhoto(groupId, filePath, {
        message_thread_id: topicId,
        caption: content !== fileUrl ? content : undefined,
      });
      return;
    }

    if (type === 'file' && fileUrl) {
      const filePath = requireMediaFilePath(fileUrl);
      await bot.sendDocument(groupId, filePath, { message_thread_id: topicId });
      return;
    }

    await bot.sendMessage(groupId, content, { message_thread_id: topicId });
  }

  const visitor = stmts.getVisitor.get(visitorId) as VisitorRecord | undefined;
  let topicId = visitor?.telegram_topic_id || null;

  if (!topicId) {
    topicId = await createTopicForVisitor(visitorId, siteName);
  }
  if (!topicId) return;

  try {
    await sendToTopicId(topicId);
  } catch (err) {
    if (isMissingThreadError(err)) {
      clearVisitorTopic(visitorId);
      const replacementTopicId = await createTopicForVisitor(visitorId, siteName);
      if (replacementTopicId) {
        try {
          await sendToTopicId(replacementTopicId);
          return;
        } catch (retryErr) {
          const retryError = retryErr as Error;
          console.error('[Telegram] Error sending to recreated topic:', retryError.message);
          return;
        }
      }
    }

    const error = err as Error;
    console.error('[Telegram] Error sending to topic:', error.message);
  }
}

async function sendTypingToTopic(visitorId: string): Promise<void> {
  if (!bot || !groupId) return;

  try {
    const visitor = stmts.getVisitor.get(visitorId) as VisitorRecord | undefined;
    const topicId = visitor?.telegram_topic_id;
    if (!topicId) return;

    await bot.sendChatAction(groupId, 'typing', { message_thread_id: topicId });
  } catch (err) {
    if (isMissingThreadError(err)) {
      clearVisitorTopic(visitorId);
    }
    // Best effort typing indicator only
  }
}

async function shutdown(): Promise<void> {
  const currentBot = bot;
  const mode = activeMode;
  bot = null;
  groupId = null;
  wsBroadcast = null;
  presenceChangeHook = null;
  activeMode = null;

  if (!currentBot) return;

  try {
    if (mode === 'polling' && currentBot.isPolling()) {
      await currentBot.stopPolling();
    }
  } catch {
    // Ignore shutdown polling errors
  }
  currentBot.removeAllListeners();
}

export {
  init,
  processWebhookUpdate,
  sendToTopic,
  createTopicForVisitor,
  sendTypingToTopic,
  shutdown,
  type TelegramMode,
};

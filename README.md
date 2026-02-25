# live-chat-widget

Live chat widget that routes every conversation to a Telegram group topic. Your team replies from Telegram — visitors see responses in real time on your site.

> **Want managed hosting?** We'll run it for you — [get started in 2 minutes](https://buzz-line.com/#pricing).

## How it works

1. Visitor opens the chat widget on your site
2. Their message creates a topic in your Telegram group
3. Your team replies from Telegram
4. The reply appears in the widget instantly

One Telegram group handles all your sites. Each visitor gets their own topic thread.

## Deploy

### Docker (recommended)

```bash
docker run -d -p 3000:3000 \
  -v buzz_data:/app/data \
  --env-file .env \
  ghcr.io/buzz-line/live-chat-widget
```

### Docker Compose

```yaml
services:
  buzz-line:
    image: ghcr.io/buzz-line/live-chat-widget
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

```bash
docker compose up -d
```

### Build from source

```bash
git clone https://github.com/buzz-line/live-chat-widget.git
cd live-chat-widget
npm install
npm run build
node dist/index.js
```

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Save the bot token
3. Create a Telegram group, add your bot as admin, and enable **Topics**
4. Get the group ID — add [@raw_data_bot](https://t.me/raw_data_bot) to the group temporarily to see it (starts with `-100`)

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```bash
# Required
TELEGRAM_BOT_TOKEN=<from-botfather>
TELEGRAM_GROUP_ID=<your-group-id>
TELEGRAM_WEBHOOK_URL=https://<your-server>/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 16>
ALLOWED_ORIGINS=https://<your-site>
JWT_SECRET=<openssl rand -hex 32>
```

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_GROUP_ID` | Your support group ID (starts with `-100`) |
| `TELEGRAM_WEBHOOK_URL` | Public HTTPS URL of your server + `/api/telegram/webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | Random string to verify webhook requests |
| `ALLOWED_ORIGINS` | Domain(s) where the widget is embedded, comma-separated |
| `JWT_SECRET` | Random string for signing auth tokens |

For local development, use `TELEGRAM_MODE=polling` instead of webhooks.

### 3. Embed the widget

```html
<script>
  window.LiveChatConfig = {
    server: 'https://<your-chat-server>',
    title: 'Support chat',
    subtitle: 'Replies usually within minutes'
  };
</script>
<script
  src="https://<your-chat-server>/widget/widget.js"
  data-site="<your-site-domain>"
></script>
```

Anonymous mode works out of the box. For authenticated chat (linking messages to logged-in users), add `data-auth-endpoint="/api/widget-token"` and see `examples/token-endpoint-express.ts`.

### 4. Verify

```bash
curl https://<your-server>/health
# {"status":"ok"}
```

Open your site, send a message through the widget, and confirm it appears as a new topic in your Telegram group. Reply from Telegram and watch it sync back.

## Features

- Real-time WebSocket messaging
- Each visitor gets a Telegram forum topic
- Image uploads (drag & drop, paste, file picker)
- Anonymous or authenticated mode
- Multiple sites on one server
- Typing indicators and read receipts
- Support presence (`/support_online`, `/support_offline` in Telegram)
- Auto-reconnect with exponential backoff
- Rate limiting per site and per user
- SQLite storage — no external databases

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `POST` | `/api/auth/anonymous` | Get anonymous token |
| `POST` | `/api/auth/revoke` | Revoke a session |
| `GET` | `/api/chat/:visitorId/history` | Message history |
| `POST` | `/api/chat/:visitorId/message` | Send message |
| `POST` | `/api/chat/:visitorId/upload` | Upload image |

## License

MIT

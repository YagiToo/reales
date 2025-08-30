Real Estate Assistant (Minimal)

- Backend: Node HTTP server (no external deps) with SSE, Telegram webhook, and OpenAI relay
- Frontend: Single HTML with modern dark UI served inline
- Property data: OpenStreetMap (Nominatim + Overpass) with placeholder images

Setup

1. Create `.env` in project root:

```
PORT=4000
OPENAI_API_KEY=your_openai_key
TELEGRAM_BOT_TOKEN=your_telegram_token
TELEGRAM_BOT_USERNAME=your_bot_username
PUBLIC_APP_URL=https://your.public.domain
```

2. Run:

```
node server.js
```

3. Web app at: `http://localhost:4000`

Telegram Webhook

- Set webhook: `POST /telegram/set-webhook`
- Delete webhook: `POST /telegram/delete-webhook`
- Incoming webhook path: `/telegram/${TELEGRAM_BOT_TOKEN}`

API

- `POST /api/chat` body `{ messages: [{role, content}, ...] }` -> `{ reply, properties }`
- `POST /api/properties` body `{ place: string }` -> `{ properties }`

Notes

- This uses public OSM endpoints; rate limits apply.
- Images are illustrative via Unsplash randomizer.

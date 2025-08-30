/* Minimal full-stack server with SSE, Telegram bot webhook, and OpenAI relay */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load .env manually (no external deps)
function loadEnvFromFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (!process.env[key] && key) process.env[key] = val;
    }
  } catch {}
}
loadEnvFromFile();

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`;

const SSE_CLIENTS = new Set();

function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of SSE_CLIENTS) {
    res.write(payload);
  }
}

function serveStatic(req, res) {
  const parsedUrl = url.parse(req.url);
  let pathname = `${parsedUrl.pathname}`;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  return false;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

async function openaiChat(messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content || '';
}

async function geocodePlace(query) {
  const urlStr = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=1`;
  const res = await fetch(urlStr, { headers: { 'User-Agent': 'realestate-bot/1.0' } });
  if (!res.ok) return null;
  const arr = await res.json();
  return arr?.[0] || null;
}

async function fetchPropertiesNear(lat, lon) {
  // Use OpenStreetMap Overpass API to query buildings tagged with addr and real estate related tags
  const overpass = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(
    `[out:json][timeout:25];(nwr["building"]["addr:street"](around:3000,${lat},${lon});nwr["amenity"="real_estate_agent"](around:3000,${lat},${lon}););out center 20;`
  )}`;
  const res = await fetch(overpass, { headers: { 'User-Agent': 'realestate-bot/1.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  const items = (data.elements || []).map((el) => {
    const name = el.tags?.name || el.tags?.["addr:housename"] || 'Property';
    const street = el.tags?.["addr:street"] || '';
    const housenumber = el.tags?.["addr:housenumber"] || '';
    const city = el.tags?.["addr:city"] || el.tags?.["addr:town"] || '';
    const displayAddress = [housenumber, street, city].filter(Boolean).join(' ');
    const center = el.center || { lat: el.lat, lon: el.lon };
    const img = `https://source.unsplash.com/800x600/?house,building,home,real-estate&sig=${el.id}`; // placeholder image
    return {
      id: el.id,
      title: name,
      address: displayAddress || 'Address unavailable',
      latitude: center?.lat,
      longitude: center?.lon,
      imageUrl: img,
      source: 'OSM/Overpass'
    };
  });
  return items.slice(0, 10);
}

async function findProperties(query) {
  const place = await geocodePlace(query);
  if (!place) return [];
  const props = await fetchPropertiesNear(place.lat, place.lon);
  return props;
}

function renderHTML() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Real Estate Assistant</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, Helvetica, sans-serif; background:#0b0f1a; color:#e5e7eb; }
    header { padding:16px 24px; border-bottom:1px solid #111827; background:#0f1424; display:flex; align-items:center; justify-content:space-between }
    .brand { font-weight:700; letter-spacing:0.5px }
    .container { display:grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 64px); }
    .sidebar { border-right:1px solid #111827; padding:16px; background:#0f1424 }
    .main { padding:16px; }
    .card { background:#0b1120; border:1px solid #111827; border-radius:12px; padding:16px; }
    .row { display:flex; gap:12px; align-items:center }
    .btn { background:#1f2937; color:#e5e7eb; padding:10px 14px; border-radius:10px; border:1px solid #374151; cursor:pointer }
    .btn:hover { background:#273244 }
    .input { width:100%; background:#0b1120; border:1px solid #1f2937; color:#e5e7eb; padding:10px 12px; border-radius:10px }
    .chat { display:flex; flex-direction:column; gap:10px; max-height:60vh; overflow:auto }
    .bubble { padding:10px 12px; border-radius:10px; max-width:80% }
    .user { background:#1f2937; align-self:flex-end }
    .bot { background:#0a0f1f; border:1px solid #1f2538; align-self:flex-start }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:12px }
    .prop img { width:100%; height:140px; object-fit:cover; border-radius:10px }
    .muted { color:#9ca3af; font-size:12px }
  </style>
  <script>
    const state = { messages: [], properties: [] };
    function addMessage(role, content) {
      state.messages.push({ role, content });
      render();
    }
    async function sendMessage() {
      const input = document.getElementById('msg');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMessage('user', text);
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: state.messages }) });
      const data = await res.json();
      if (data.reply) addMessage('assistant', data.reply);
      if (data.properties) { state.properties = data.properties; render(); }
    }
    function render() {
      const chat = document.getElementById('chat');
      chat.innerHTML = state.messages.map(m => `<div class="bubble ${m.role==='user'?'user':'bot'}">${m.content.replace(/</g,'&lt;')}</div>`).join('');
      chat.scrollTop = chat.scrollHeight;
      const grid = document.getElementById('props');
      grid.innerHTML = state.properties.map(p => `
        <div class="card prop">
          <img src="${p.imageUrl}" alt="${p.title}"/>
          <div style="padding-top:8px">
            <div style="font-weight:600">${p.title}</div>
            <div class="muted">${p.address}</div>
            <div class="muted">${p.source}</div>
          </div>
        </div>
      `).join('');
    }
    window.addEventListener('DOMContentLoaded', () => {
      const es = new EventSource('/events');
      es.addEventListener('connected', () => {});
      es.addEventListener('telemetry', (e) => {
        const d = JSON.parse(e.data);
        const el = document.getElementById('telemetry');
        el.textContent = d.message;
      });
      document.getElementById('btnSetWebhook').addEventListener('click', async () => {
        await fetch('/telegram/set-webhook', { method: 'POST' });
      });
      document.getElementById('btnDeleteWebhook').addEventListener('click', async () => {
        await fetch('/telegram/delete-webhook', { method: 'POST' });
      });
      document.getElementById('btnSearch').addEventListener('click', async () => {
        const q = prompt('Enter a place (city, area):');
        if (!q) return;
        const res = await fetch('/api/properties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ place: q }) });
        const data = await res.json();
        if (data.properties) { state.properties = data.properties; render(); }
      });
      render();
    });
  </script>
</head>
<body>
  <header>
    <div class="brand">Real Estate Assistant</div>
    <div class="row">
      <a class="btn" href="${TELEGRAM_BOT_USERNAME ? `https://t.me/${TELEGRAM_BOT_USERNAME}` : '#'}" target="_blank">Open Telegram Bot</a>
    </div>
  </header>
  <div class="container">
    <aside class="sidebar">
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">Dashboard</div>
        <div id="telemetry" class="muted">Idle</div>
        <div style="height:8px"></div>
        <div class="row">
          <button id="btnSetWebhook" class="btn">Set Telegram Webhook</button>
        </div>
        <div style="height:8px"></div>
        <div class="row">
          <button id="btnDeleteWebhook" class="btn">Delete Telegram Webhook</button>
        </div>
        <div style="height:8px"></div>
        <div class="row">
          <button id="btnSearch" class="btn">Quick Property Search</button>
        </div>
      </div>
    </aside>
    <main class="main">
      <div class="card" style="margin-bottom:12px">
        <div class="row">
          <input id="msg" class="input" placeholder="Ask about properties... e.g., 2 bedroom in Brooklyn" onkeydown="if(event.key==='Enter') sendMessage()" />
          <button class="btn" onclick="sendMessage()">Send</button>
        </div>
      </div>
      <div class="card chat" id="chat"></div>
      <div style="height:12px"></div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">Suggested Properties</div>
        <div id="props" class="grid"></div>
      </div>
    </main>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  // CORS/simple headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderHTML());
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: connected\ndata: {"ok":true}\n\n`);
    SSE_CLIENTS.add(res);
    req.on('close', () => { SSE_CLIENTS.delete(res); });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/properties' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const place = (body?.place || '').trim();
      if (!place) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing_place' })); }
      sendSSE('telemetry', { message: `Searching properties near ${place}` });
      const properties = await findProperties(place);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ properties }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
    return;
  }

  if (req.url === '/api/chat' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      sendSSE('telemetry', { message: 'Processing chat via OpenAI' });
      let reply = '';
      try {
        reply = await openaiChat(messages);
      } catch (e) {
        reply = 'Sorry, I could not contact the AI right now.';
      }

      // simple intent: if user asked for properties at/near a place, try finding
      const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      let properties = [];
      const placeMatch = lastUser.match(/in ([a-zA-Z\s,]+)$|near ([a-zA-Z\s,]+)$|at ([a-zA-Z\s,]+)$/i);
      if (placeMatch) {
        const place = (placeMatch[1] || placeMatch[2] || placeMatch[3] || '').trim();
        if (place) {
          sendSSE('telemetry', { message: `Searching properties near ${place}` });
          try { properties = await findProperties(place); } catch {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, properties }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
    return;
  }

  // Telegram webhook
  if (req.url === `/telegram/${TELEGRAM_BOT_TOKEN}` && req.method === 'POST') {
    const update = await parseBody(req);
    try {
      const chatId = update?.message?.chat?.id;
      const text = update?.message?.text || '';
      if (!chatId) { res.writeHead(200); return res.end('ok'); }
      sendSSE('telemetry', { message: 'Telegram message received' });
      let reply = 'Hi! Ask me about properties in a location.';
      if (text) {
        try { reply = await openaiChat([{ role: 'user', content: text }]); } catch {}
      }
      // properties if place detected
      let properties = [];
      const placeMatch = text.match(/in ([a-zA-Z\s,]+)$|near ([a-zA-Z\s,]+)$|at ([a-zA-Z\s,]+)$/i);
      if (placeMatch) {
        const place = (placeMatch[1] || placeMatch[2] || placeMatch[3] || '').trim();
        if (place) { try { properties = await findProperties(place); } catch {} }
      }
      const propertySummary = properties.slice(0, 3).map(p => `${p.title} - ${p.address}`).join('\n');
      const finalReply = propertySummary ? `${reply}\n\nHere are some nearby options:\n${propertySummary}` : reply;
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: finalReply })
      });
      if (properties[0]) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: properties[0].imageUrl, caption: `${properties[0].title} - ${properties[0].address}` })
        });
      }
    } catch (e) {}
    res.writeHead(200); res.end('ok');
    return;
  }

  if (req.url === '/telegram/set-webhook' && req.method === 'POST') {
    try {
      const webhookUrl = `${PUBLIC_APP_URL}/telegram/${TELEGRAM_BOT_TOKEN}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl })
      });
      const out = await tgRes.json().catch(() => ({}));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: out }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'telegram_error' }));
    }
    return;
  }

  if (req.url === '/telegram/delete-webhook' && req.method === 'POST') {
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
      const out = await tgRes.json().catch(() => ({}));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: out }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'telegram_error' }));
    }
    return;
  }

  if (!serveStatic(req, res)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) console.warn('Missing OPENAI_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) console.warn('Missing TELEGRAM_BOT_TOKEN');
});


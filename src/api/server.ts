import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { search, type SearchScope } from "../search/retrieval.js";
import { generateAnswer } from "../search/answerGeneration.js";
import { llmQueueDepth } from "../ai/client.js";
import type { Logger } from "pino";

function scopeFromPageUrl(pageUrl: string | undefined): SearchScope | undefined {
  if (!pageUrl) return undefined;
  try {
    const { pathname } = new URL(pageUrl);
    // /doc/<slug> → doc-level search
    if (pathname.startsWith("/doc/")) return { docPath: pathname };
    // /collection/<slug>-<uuid> → collection-level search
    // Outline collection IDs are UUIDs at the end after last dash
    if (pathname.startsWith("/collection/")) {
      const slug = pathname.replace("/collection/", "");
      const parts = slug.split("-");
      if (parts.length >= 5) {
        // UUID is last 5 dash-separated segments
        const collectionId = parts.slice(-5).join("-");
        return { collectionId };
      }
    }
  } catch { /* invalid URL, fall through to full search */ }
  return undefined;
}

const SCORE_THRESHOLD = 0.3;

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", config.API_CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function serveWidget(res: ServerResponse): void {
  cors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(widgetJs());
}

function widgetJs(): string {
  return `(function(){
  if(document.getElementById('kb-widget-root')) return;
  const API = '/kb/search';

  const style = document.createElement('style');
  style.textContent = \`
    #kb-widget-root * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    #kb-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: #3b82f6; border: none; cursor: pointer;
      box-shadow: 0 4px 14px rgba(59,130,246,.5);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 22px; transition: transform .15s;
    }
    #kb-btn:hover { transform: scale(1.08); }
    #kb-panel {
      position: fixed; bottom: 88px; right: 24px; z-index: 9999;
      width: 360px; max-height: 520px;
      background: #1e2433; border: 1px solid #2d3748; border-radius: 12px;
      display: flex; flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,.4);
      overflow: hidden;
    }
    #kb-panel.hidden { display: none; }
    #kb-header {
      padding: 12px 16px; background: #232b3e;
      border-bottom: 1px solid #2d3748;
      display: flex; justify-content: space-between; align-items: center;
    }
    #kb-header span { color: #7dd3fc; font-weight: 600; font-size: .9rem; }
    #kb-close { background: none; border: none; color: #64748b; cursor: pointer; font-size: 18px; line-height: 1; }
    #kb-close:hover { color: #e2e8f0; }
    #kb-messages {
      flex: 1; overflow-y: auto; padding: 12px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .kb-msg { padding: 10px 12px; border-radius: 8px; font-size: .85rem; line-height: 1.5; }
    .kb-msg.user { background: #2d3748; color: #e2e8f0; align-self: flex-end; max-width: 85%; }
    .kb-msg.bot { background: #1a2030; color: #cbd5e1; align-self: flex-start; max-width: 100%; }
    .kb-msg.error { background: #7f1d1d22; color: #f87171; }
    .kb-sources { margin-top: 8px; padding-top: 8px; border-top: 1px solid #2d3748; font-size: .75rem; color: #64748b; }
    .kb-sources a { color: #7dd3fc; text-decoration: none; display: block; margin-top: 3px; }
    .kb-sources a:hover { text-decoration: underline; }
    #kb-input-row {
      display: flex; gap: 8px; padding: 10px 12px;
      border-top: 1px solid #2d3748; background: #1a2030;
    }
    #kb-input {
      flex: 1; background: #0f1117; border: 1px solid #2d3748;
      border-radius: 6px; padding: 8px 10px;
      color: #e2e8f0; font-size: .85rem; outline: none;
    }
    #kb-input:focus { border-color: #3b82f6; }
    #kb-send {
      background: #3b82f6; border: none; border-radius: 6px;
      color: #fff; padding: 8px 14px; cursor: pointer; font-size: .85rem;
      white-space: nowrap;
    }
    #kb-send:disabled { opacity: .5; cursor: default; }
  \`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'kb-widget-root';
  root.innerHTML = \`
    <button id="kb-btn" title="Cerca nella wiki">💬</button>
    <div id="kb-panel" class="hidden">
      <div id="kb-header">
        <span>🔍 Wiki Search</span>
        <button id="kb-close">✕</button>
      </div>
      <div id="kb-messages"></div>
      <div id="kb-input-row">
        <input id="kb-input" type="text" placeholder="Fai una domanda..." />
        <button id="kb-send">Invia</button>
      </div>
    </div>
  \`;
  document.body.appendChild(root);

  const btn = document.getElementById('kb-btn');
  const panel = document.getElementById('kb-panel');
  const closeBtn = document.getElementById('kb-close');
  const messages = document.getElementById('kb-messages');
  const input = document.getElementById('kb-input');
  const send = document.getElementById('kb-send');
  const headerSpan = document.querySelector('#kb-header span');

  // Show scope hint in header
  const path = window.location.pathname;
  if (path.startsWith('/doc/')) headerSpan.textContent = '🔍 Cerca in questo documento';
  else if (path.startsWith('/collection/')) headerSpan.textContent = '🔍 Cerca in questa collezione';
  else headerSpan.textContent = '🔍 Cerca nella wiki';

  btn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) input.focus();
  });
  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

  function addMsg(text, cls, sources) {
    const el = document.createElement('div');
    el.className = 'kb-msg ' + cls;
    el.textContent = text;
    if (sources && sources.length) {
      const s = document.createElement('div');
      s.className = 'kb-sources';
      s.innerHTML = 'Fonti: ' + sources.map(src =>
        '<a href="' + src.url + '" target="_blank">📄 ' + src.title + (src.heading ? ' › ' + src.heading : '') + '</a>'
      ).join('');
      el.appendChild(s);
    }
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  async function doSearch() {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    send.disabled = true;
    addMsg(q, 'user');
    const thinking = addMsg('⏳ Cerco...', 'bot');
    // Poll queue position while waiting
    const pollTimer = setInterval(async () => {
      try {
        const q = await fetch('/kb/queue').then(r => r.json());
        if (q.pending > 0) thinking.textContent = '⏳ In coda... (' + q.pending + ' prima di te)';
        else thinking.textContent = '⏳ Elaboro...';
      } catch {}
    }, 2000);
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, pageUrl: window.location.href })
      });
      const data = await res.json();
      thinking.remove();
      if (data.error) { addMsg(data.error, 'bot error'); }
      else { addMsg(data.answer, 'bot', data.sources); }
    } catch(e) {
      thinking.remove();
      addMsg('Errore di connessione.', 'bot error');
    } finally {
      clearInterval(pollTimer);
      send.disabled = false;
      input.focus();
    }
  }

  send.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') doSearch(); });
})();`;
}

export function startApiServer(log: Logger): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (req.method === "OPTIONS") {
      cors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === "/widget.js" || url === "/kb/widget.js") {
      serveWidget(res);
      return;
    }

    if (url === "/kb/search" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { query?: string; pageUrl?: string };
        const query = parsed.query?.trim();

        if (!query) {
          json(res, 400, { error: "query mancante" });
          return;
        }

        const scope = scopeFromPageUrl(parsed.pageUrl);
        let chunks = await search(query, 5, scope);

        // If scoped search returns nothing, fall back to full wiki search
        if (scope && (chunks.length === 0 || chunks[0]!.score < SCORE_THRESHOLD)) {
          chunks = await search(query, 5);
        }

        if (!chunks.length || chunks[0]!.score < SCORE_THRESHOLD) {
          json(res, 200, {
            answer: "Non ho trovato documenti rilevanti per questa domanda.",
            sources: [],
          });
          return;
        }

        const scopeLabel = scope?.docPath ? "questo documento" : scope?.collectionId ? "questa collezione" : null;
        const result = await generateAnswer(query, chunks, scopeLabel ?? undefined);
        json(res, 200, result);
      } catch (err) {
        log.error({ err }, "api_search_error");
        json(res, 500, { error: "errore interno" });
      }
      return;
    }

    if (url === "/kb/queue") {
      cors(res);
      json(res, 200, llmQueueDepth());
      return;
    }

    if (url === "/kb/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(config.API_PORT, () => {
    log.info({ port: config.API_PORT }, "api_server_started");
  });
}

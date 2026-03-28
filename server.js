/**
 * Pinecone Help Assistant — local dev server
 *
 * Reads .env for API keys, resolves Pinecone hosts on startup,
 * serves the HTML, and proxies all API calls so keys never touch the browser.
 *
 * Usage:
 *   npm install
 *   npm start        # or: npm run dev  (auto-restarts on file changes)
 *
 * Then open: http://localhost:3000
 */

require('dotenv').config({ override: true });
const express = require('express');
const path    = require('path');

const app  = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Config ──────────────────────────────────────────────────────────────────

const PINECONE_API_KEY  = process.env.PINECONE_API_KEY  || '';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const INDEX_NAME     = 'pinecone-docs-demo';
const ASSISTANT_NAME = 'pinecone-help';
const EMBED_MODEL    = 'text-embedding-3-small';
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const PORT           = process.env.PORT || 3000;

let PINECONE_HOST  = '';
let ASSISTANT_HOST = '';

// ─── Startup: resolve hosts ───────────────────────────────────────────────────

async function resolveHosts() {
  if (!PINECONE_API_KEY) {
    console.warn('⚠  PINECONE_API_KEY not set — check your .env file');
    return;
  }

  // Pinecone index host (for RAG mode)
  try {
    const res  = await fetch(`https://api.pinecone.io/indexes/${INDEX_NAME}`, {
      headers: { 'Api-Key': PINECONE_API_KEY, 'X-Pinecone-API-Version': '2024-07' }
    });
    const data = await res.json();
    if (res.ok) {
      PINECONE_HOST = `https://${data.host}`;
      console.log(`✓ Pinecone index  : ${PINECONE_HOST}`);
    } else {
      console.warn(`⚠  Pinecone index "${INDEX_NAME}" not found — RAG mode unavailable`);
    }
  } catch (e) {
    console.warn('⚠  Could not reach Pinecone index:', e.message);
  }

  // Pinecone Assistant host
  try {
    const res  = await fetch(`https://api.pinecone.io/assistant/assistants/${ASSISTANT_NAME}`, {
      headers: { 'Api-Key': PINECONE_API_KEY, 'X-Pinecone-API-Version': '2024-07' }
    });
    const data = await res.json();
    if (res.ok) {
      ASSISTANT_HOST = data.host
        ? (data.host.startsWith('http') ? data.host : `https://${data.host}`)
        : 'https://prod-1-data.ke.pinecone.io';
      console.log(`✓ Assistant       : ${ASSISTANT_HOST}`);
    } else {
      console.warn(`⚠  Assistant "${ASSISTANT_NAME}" not found — run pinecone_assistant_ingest.py first`);
    }
  } catch (e) {
    console.warn('⚠  Could not reach Pinecone Assistant:', e.message);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'pinecone_rag_demo_live.html'));
});

// Config — tells the frontend which services are available
app.get('/api/config', (_req, res) => {
  res.json({
    indexName:     INDEX_NAME,
    assistantName: ASSISTANT_NAME,
    embedModel:    EMBED_MODEL,
    claudeModel:   CLAUDE_MODEL,
    pineconeReady: !!PINECONE_API_KEY,
    assistantReady:!!ASSISTANT_HOST,
    ragReady:      !!OPENAI_API_KEY && !!ANTHROPIC_API_KEY && !!PINECONE_API_KEY,
  });
});

// Embed query via OpenAI
app.post('/api/embed', async (req, res) => {
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Strip code/JSON noise left behind by the scraper (pre/code blocks).
// Lines that are predominantly punctuation characters typical of Python dicts
// and JSON (braces, brackets, quotes, colons) are removed.
function cleanChunkText(text) {
  const lines = text.split(/\s{2,}|\n/);
  const prose = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    const codeChars = (trimmed.match(/[{}\[\]'":,]/g) || []).length;
    // Drop lines where more than 40% of chars are code punctuation
    return codeChars / trimmed.length < 0.4;
  });
  return prose.join(' ').replace(/\s+/g, ' ').trim();
}

// Query Pinecone index (RAG mode)
app.post('/api/pinecone/query', async (req, res) => {
  if (!PINECONE_HOST) return res.status(503).json({ error: 'Pinecone index not available' });
  try {
    const response = await fetch(`${PINECONE_HOST}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PINECONE_API_KEY,
        'X-Pinecone-API-Version': '2024-07',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    // Clean code-block noise from chunk text before sending to frontend
    if (data.matches) {
      data.matches = data.matches.map(m => {
        if (m.metadata?.text) m.metadata.text = cleanChunkText(m.metadata.text);
        return m;
      });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate answer via Anthropic Claude (RAG mode)
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat with Pinecone Assistant
app.post('/api/assistant/chat', async (req, res) => {
  if (!ASSISTANT_HOST) return res.status(503).json({ error: 'Pinecone Assistant not available' });
  try {
    const response = await fetch(`${ASSISTANT_HOST}/assistant/chat/${ASSISTANT_NAME}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PINECONE_API_KEY,
        'X-Pinecone-API-Version': '2024-07',
      },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    console.log(`[assistant/chat] ${response.status} →`, text.slice(0, 500));
    if (!response.ok) return res.status(response.status).json({ error: text });
    res.json(JSON.parse(text));
  } catch (e) {
    console.error('[assistant/chat] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

resolveHosts().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🌲 Pinecone demo running → http://localhost:${PORT}\n`);
  });
});

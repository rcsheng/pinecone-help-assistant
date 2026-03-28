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
const fs      = require('fs');

const app  = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Config ──────────────────────────────────────────────────────────────────

const PINECONE_API_KEY  = process.env.PINECONE_API_KEY  || '';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const COHERE_API_KEY    = process.env.COHERE_API_KEY    || '';

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

// ─── Live reload (dev only) ───────────────────────────────────────────────────

const liveReloadClients = new Set();

fs.watch(path.join(__dirname, 'pinecone_rag_demo_live.html'), () => {
  for (const res of liveReloadClients) {
    res.write('data: reload\n\n');
  }
});

app.get('/api/livereload', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  liveReloadClients.add(res);
  req.on('close', () => liveReloadClients.delete(res));
});

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
    cohereReady:   !!COHERE_API_KEY,
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

// ─── Retrieval Explorer helpers ───────────────────────────────────────────────

async function llmCall(prompt, maxTokens = 400) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data.error?.message}`);
  return data.content?.[0]?.text?.trim() || '';
}

async function embedText(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ input: text, model: EMBED_MODEL }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI embed: ${data.error?.message}`);
  return data.data[0].embedding;
}

async function queryIndex(vector, topK, namespace) {
  const res = await fetch(`${PINECONE_HOST}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': PINECONE_API_KEY, 'X-Pinecone-API-Version': '2024-07' },
    body: JSON.stringify({ vector, topK, includeMetadata: true, ...(namespace ? { namespace } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Pinecone: ${data.message}`);
  return data.matches || [];
}

function rrfMerge(matchLists, k = 60) {
  const map = new Map();
  for (const list of matchLists) {
    list.forEach((m, rank) => {
      const prev = map.get(m.id) || { m, score: 0 };
      map.set(m.id, { m, score: prev.score + 1 / (k + rank + 1) });
    });
  }
  return [...map.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ m, score }) => ({ ...m, score }));
}

function bigramSimilarity(a, b) {
  const bigrams = s => {
    const tokens = s.toLowerCase().split(/\s+/);
    const bg = new Set();
    for (let i = 0; i < tokens.length - 1; i++) bg.add(`${tokens[i]} ${tokens[i+1]}`);
    return bg;
  };
  const bA = bigrams(a), bB = bigrams(b);
  if (!bA.size || !bB.size) return 0;
  const inter = [...bA].filter(bg => bB.has(bg)).length;
  return inter / Math.max(bA.size, bB.size);
}

function parseLLMJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

// ─── Retrieval Explorer endpoint ─────────────────────────────────────────────

app.post('/api/retrieval-explorer', async (req, res) => {
  const { query, config } = req.body;
  if (!query)         return res.status(400).json({ error: 'query is required' });
  if (!PINECONE_HOST) return res.status(503).json({ error: 'Pinecone index not available' });
  if (!OPENAI_API_KEY || !ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'RAG dependencies missing (OPENAI_API_KEY, ANTHROPIC_API_KEY)' });

  const { index, query_transform, reranking, context } = config;
  const ns = index.namespace_filter || null;

  try {
    // ── 1. Query transformation ───────────────────────────────────────────────
    let transformedQueries = [];
    let multiQueries = null;
    let retrievalQuery = query;

    if (query_transform.type === 'hyde') {
      const hypo = await llmCall(
        `Write a 2–3 sentence technical answer to this question, as if from documentation:\n\n"${query}"\n\nAnswer only, no preamble.`,
        300
      );
      transformedQueries = [hypo];
      retrievalQuery = hypo;

    } else if (query_transform.type === 'step_back') {
      const abstract = await llmCall(
        `Rephrase this question as a broader, more general version (one sentence only):\n\n"${query}"\n\nReturn only the rephrased question.`,
        150
      );
      transformedQueries = [abstract];
      retrievalQuery = abstract;

    } else if (query_transform.type === 'multi_query') {
      const n = query_transform.num_variants || 3;
      const raw = await llmCall(
        `Generate ${n} different phrasings of this question. Return a JSON array of strings only, no preamble:\n\n"${query}"`,
        400
      );
      const variants = parseLLMJsonArray(raw).slice(0, n);
      transformedQueries = variants.length ? variants : [query];
      multiQueries = transformedQueries;

    } else if (query_transform.type === 'decompose') {
      const n = query_transform.num_variants || 3;
      const raw = await llmCall(
        `Break this question into ${n} simpler sub-questions. Return a JSON array of strings only, no preamble:\n\n"${query}"`,
        400
      );
      const subs = parseLLMJsonArray(raw).slice(0, n);
      transformedQueries = subs.length ? subs : [query];
      multiQueries = transformedQueries;
    }

    // ── 2. Embed and retrieve ─────────────────────────────────────────────────
    let rawMatches;
    if (multiQueries) {
      const allLists = await Promise.all(
        multiQueries.map(q => embedText(q).then(vec => queryIndex(vec, index.top_k, ns)))
      );
      rawMatches = rrfMerge(allLists);
    } else {
      const vec = await embedText(retrievalQuery);
      rawMatches = await queryIndex(vec, index.top_k, ns);
    }

    // ── 3. Build candidate list ───────────────────────────────────────────────
    let candidates = rawMatches.slice(0, index.top_k).map((m, i) => ({
      id: m.id,
      rank: i + 1,
      original_rank: null,
      score: m.score,
      original_score: null,
      text: cleanChunkText(m.metadata?.text || ''),
      metadata: m.metadata || {},
    }));

    // ── 4. Reranking ─────────────────────────────────────────────────────────
    let rerankerUsed = null;

    if (reranking.model === 'pinecone' && candidates.length > 0) {
      try {
        const rRes = await fetch('https://api.pinecone.io/rerank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Api-Key': PINECONE_API_KEY, 'X-Pinecone-API-Version': '2024-10' },
          body: JSON.stringify({
            model: 'bge-reranker-v2-m3',
            query,
            return_documents: false,
            top_n: candidates.length,
            documents: candidates.map(c => ({ id: String(c.rank - 1), text: c.text })),
          }),
        });
        const rData = await rRes.json();
        if (rRes.ok && rData.results) {
          const orig = [...candidates];
          candidates = rData.results.map((r, newRank) => {
            const o = orig[r.index];
            return { ...o, rank: newRank + 1, original_rank: o.rank, score: r.score, original_score: o.score };
          });
          rerankerUsed = 'pinecone';
        } else {
          console.warn('[rerank/pinecone]', rData);
        }
      } catch (e) { console.warn('[rerank/pinecone]', e.message); }

    } else if (reranking.model === 'cohere' && COHERE_API_KEY && candidates.length > 0) {
      try {
        const rRes = await fetch('https://api.cohere.com/v2/rerank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${COHERE_API_KEY}` },
          body: JSON.stringify({ model: 'rerank-v3.5', query, top_n: candidates.length, documents: candidates.map(c => c.text) }),
        });
        const rData = await rRes.json();
        if (rRes.ok && rData.results) {
          const orig = [...candidates];
          candidates = rData.results.map((r, newRank) => {
            const o = orig[r.index];
            return { ...o, rank: newRank + 1, original_rank: o.rank, score: r.relevance_score, original_score: o.score };
          });
          rerankerUsed = 'cohere';
        }
      } catch (e) { console.warn('[rerank/cohere]', e.message); }
    }

    // ── 5. Deduplication ─────────────────────────────────────────────────────
    if (context.deduplicate) {
      const kept = [];
      for (const c of candidates) {
        if (!kept.some(k => bigramSimilarity(k.text, c.text) > 0.85)) kept.push(c);
      }
      candidates = kept;
    }

    // ── 6. Context assembly ───────────────────────────────────────────────────
    let selected = candidates.slice(0, context.num_chunks);

    if (context.ordering === 'reversed') {
      selected = [...selected].reverse();
    } else if (context.ordering === 'relevant_ends' && selected.length > 2) {
      const [first, ...rest] = selected;
      const last = rest.pop();
      selected = [first, ...rest.reverse(), last];
    }

    if (context.compression !== 'none') {
      selected = await Promise.all(selected.map(async c => {
        const prompt = context.compression === 'summarize'
          ? `Summarize this text in 2–3 sentences, focusing on what's relevant to: "${query}"\n\nText: ${c.text}\n\nSummary only:`
          : `Extract the 2–3 most relevant sentences from this text for the question: "${query}"\n\nText: ${c.text}\n\nReturn only the extracted sentences.`;
        return { ...c, text: await llmCall(prompt, 200) };
      }));
    }

    const assembledContext = selected
      .map((c, i) => `[${i + 1}] ${c.metadata.source || ''}\n${c.text}`)
      .join('\n\n');

    // ── 7. Generate answer ────────────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 1000,
        system: `You are a precise technical assistant answering questions using only the provided Pinecone documentation context.

Rules:
- Answer using ONLY the provided context
- Use inline citations [1][2][3] after each factual claim
- Be concise and technical — 3–5 sentences
- Lead with the most important insight
- If context is insufficient, say so clearly`,
        messages: [{ role: 'user', content: `Context:\n${assembledContext}\n\nQuestion: ${query}\n\nAnswer with inline citations:` }],
      }),
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(claudeRes.status).json({ error: `Claude: ${claudeData.error?.message}` });

    res.json({
      trace: {
        original_query:      query,
        transformed_queries: transformedQueries,
        candidates_retrieved: rawMatches.length,
        reranker_used:       rerankerUsed,
      },
      chunks:            candidates,
      assembled_context: assembledContext,
      answer:            claudeData.content?.[0]?.text || '',
    });

  } catch (e) {
    console.error('[retrieval-explorer]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

resolveHosts().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🌲 Pinecone demo running → http://localhost:${PORT}\n`);
  });
});

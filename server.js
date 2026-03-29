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
  // Heartbeat every 25s to prevent browser/proxy from closing the SSE connection
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); liveReloadClients.delete(res); });
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
    evalDataset:   EVAL_DATASET,
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

// ─── Retrieval pipeline helper ───────────────────────────────────────────────

function makeBaseConfig({ transform = 'none', topK = 5, reranker = 'none', numChunks = 3, numVariants = 3 } = {}) {
  return {
    chunking:        { strategy: 'fixed', namespace: null },
    query_transform: { type: transform, num_variants: numVariants },
    index:           { top_k: topK, namespace_filter: null, include_metadata: true },
    retrieval:       { mode: 'dense', fusion: 'rrf', alpha: 0.7 },
    reranking:       { model: reranker, top_n: numChunks },
    context:         { num_chunks: numChunks, ordering: 'as_retrieved', compression: 'none', deduplicate: false },
  };
}

async function runPipeline(query, config) {
  const { index, query_transform, reranking, context } = config;
  const ns = index.namespace_filter || null;

  // ── 1. Query transformation ───────────────────────────────────────────────
  let transformedQueries = [];
  let multiQueries = null;
  let retrievalQuery = query;

  if (query_transform.type === 'hyde') {
    const hypo = await llmCall(
      `Write a 2\u20133 sentence technical answer to this question, as if from documentation:\n\n"${query}"\n\nAnswer only, no preamble.`,
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
        ? `Summarize this text in 2\u20133 sentences, focusing on what's relevant to: "${query}"\n\nText: ${c.text}\n\nSummary only:`
        : `Extract the 2\u20133 most relevant sentences from this text for the question: "${query}"\n\nText: ${c.text}\n\nReturn only the extracted sentences.`;
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
      system: `You are a precise technical assistant answering questions using only the provided Pinecone documentation context.\n\nRules:\n- Answer using ONLY the provided context\n- Use inline citations [1][2][3] after each factual claim\n- Be concise and technical \u2014 3\u20135 sentences\n- Lead with the most important insight\n- If context is insufficient, say so clearly`,
      messages: [{ role: 'user', content: `Context:\n${assembledContext}\n\nQuestion: ${query}\n\nAnswer with inline citations:` }],
    }),
  });
  const claudeData = await claudeRes.json();
  if (!claudeRes.ok) throw new Error(`Claude: ${claudeData.error?.message}`);

  return {
    trace: {
      original_query:       query,
      transformed_queries:  transformedQueries,
      candidates_retrieved: rawMatches.length,
      reranker_used:        rerankerUsed,
    },
    chunks:            candidates,
    assembled_context: assembledContext,
    answer:            claudeData.content?.[0]?.text || '',
  };
}

// ─── Retrieval Explorer endpoint ─────────────────────────────────────────────

app.post('/api/retrieval-explorer', async (req, res) => {
  const { query, config } = req.body;
  if (!query)         return res.status(400).json({ error: 'query is required' });
  if (!PINECONE_HOST) return res.status(503).json({ error: 'Pinecone index not available' });
  if (!OPENAI_API_KEY || !ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'RAG dependencies missing (OPENAI_API_KEY, ANTHROPIC_API_KEY)' });

  try {
    const result = await runPipeline(query, config);
    res.json(result);
  } catch (e) {
    console.error('[retrieval-explorer]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Retrieval Eval ───────────────────────────────────────────────────────────

// Ground-truth sources confirmed by querying the live index.
// The index contains exactly these 10 docs ingested from docs.pinecone.io:
//   assistant/overview, data/filter-with-metadata, data/query-data, data/upsert-data,
//   get-started/key-concepts, indexes/create-an-index, indexes/understanding-indexes,
//   inference/understanding-inference, search/hybrid-search, reference/api/introduction
const EVAL_DATASET = [
  { id: 1,
    question: 'How does hybrid search work in Pinecone?',
    reference: 'Hybrid search combines dense (semantic) and sparse (keyword) vectors in a single query. Pinecone recommends a single hybrid index using the dotproduct metric, where you upsert records containing both dense and sparse vectors. At query time you send both vector types together; results rank by a weighted blend controlled by an alpha parameter (1.0 = fully dense, 0.0 = fully sparse).',
    expected_sources: ['https://docs.pinecone.io/guides/search/hybrid-search'] },

  { id: 2,
    question: 'What is the difference between serverless and pod-based indexes?',
    reference: 'Serverless indexes auto-scale with no infrastructure management and are billed per query and storage unit — ideal for variable workloads. Pod-based indexes run on dedicated hardware pods with fixed capacity and predictable throughput — better for consistent high-volume traffic. Serverless is recommended for most new projects; pods suit applications with strict latency SLAs or very large corpora.',
    expected_sources: ['https://docs.pinecone.io/guides/indexes/understanding-indexes'] },

  { id: 3,
    question: 'How do namespaces work in Pinecone?',
    reference: 'Namespaces partition a single index into isolated segments. Vectors in different namespaces never interact — a query scoped to one namespace only returns results from that namespace. This enables multi-tenancy (one namespace per user or customer) without the overhead of maintaining separate indexes.',
    expected_sources: ['https://docs.pinecone.io/guides/get-started/key-concepts',
                       'https://docs.pinecone.io/guides/indexes/understanding-indexes'] },

  { id: 4,
    question: 'What is the Pinecone Inference API?',
    reference: 'The Pinecone Inference API provides hosted embedding and reranking models directly within the Pinecone platform, removing the need for a separate embedding provider. You can generate dense and sparse embeddings and rerank results using models such as text-embedding-3-small and bge-reranker-v2-m3 via a single API key, simplifying the RAG pipeline.',
    expected_sources: ['https://docs.pinecone.io/guides/inference/understanding-inference'] },

  { id: 5,
    question: 'How does sparse vector search differ from dense vector search?',
    reference: 'Dense vector search uses high-dimensional floating-point embeddings (e.g., 1536-d) to capture semantic meaning, enabling matches even without exact keyword overlap. Sparse vector search uses high-dimensional mostly-zero vectors (BM25 or SPLADE) to match exact or near-exact terms, excelling at keyword precision. Dense suits semantic retrieval; sparse suits keyword recall. Hybrid search combines both.',
    expected_sources: ['https://docs.pinecone.io/guides/search/hybrid-search',
                       'https://docs.pinecone.io/guides/get-started/key-concepts'] },

  { id: 6,
    question: 'What are the benefits of using Pinecone for production AI applications?',
    reference: 'Pinecone provides fully managed vector search with automatic scaling, high availability, and sub-millisecond ANN query latency at any scale. Key benefits include serverless pricing with no idle cost, metadata filtering, hybrid dense+sparse search, a hosted inference API, and native integrations with LLM frameworks like LangChain and LlamaIndex. It removes the operational burden of running and tuning a vector database.',
    expected_sources: ['https://docs.pinecone.io/guides/get-started/key-concepts'] },

  { id: 7,
    question: 'How do I upsert vectors with metadata in Pinecone?',
    reference: 'Call index.upsert() with a list of records, each containing an id (string), values (embedding array), and an optional metadata dict. For example: index.upsert(vectors=[{"id":"v1","values":[0.1,...],"metadata":{"source":"doc1","text":"..."}}]). Metadata fields can later be used in filtered queries using MongoDB-style operators.',
    expected_sources: ['https://docs.pinecone.io/guides/data/upsert-data'] },

  { id: 8,
    question: 'What distance metrics does Pinecone support for similarity search?',
    reference: 'Pinecone supports three distance metrics set at index creation: cosine similarity (default, best for normalized embeddings), euclidean distance (best when vector magnitude carries meaning), and dot product (required for hybrid search and for models that produce unnormalized embeddings). The metric cannot be changed after index creation.',
    expected_sources: ['https://docs.pinecone.io/guides/indexes/create-an-index',
                       'https://docs.pinecone.io/guides/indexes/understanding-indexes'] },

  { id: 9,
    question: 'How does Pinecone handle metadata filtering at query time?',
    reference: 'Pinecone applies server-side metadata filtering using a filter object passed in the query. Filters use MongoDB-style operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or). The filter is evaluated before ANN scoring so only matching vectors are candidates, which can reduce recall when filters are very selective. Indexed metadata fields perform better than unindexed ones.',
    expected_sources: ['https://docs.pinecone.io/guides/data/filter-with-metadata'] },

  { id: 10,
    question: 'What is the Pinecone Assistant and how does it differ from the index API?',
    reference: 'Pinecone Assistant is a fully managed RAG service that handles document ingestion, chunking, embedding, storage, retrieval, and answer generation in one API call. Unlike the index API where you control embedding and querying yourself, the Assistant takes raw documents and returns cited answers automatically. It is best when you want managed end-to-end RAG without building the pipeline.',
    expected_sources: ['https://docs.pinecone.io/guides/assistant/overview'] },
];

const OPTIMIZE_PRESETS = [
  { id: 'C1', label: 'Baseline',      desc: 'No transform \u00b7 K=5 \u00b7 No rerank \u00b7 3 chunks',
    config: makeBaseConfig({ transform: 'none',        topK: 5,  reranker: 'none',     numChunks: 3 }) },
  { id: 'C2', label: 'Pool + Rerank', desc: 'No transform \u00b7 K=10 \u00b7 Pinecone rerank \u00b7 3 chunks',
    config: makeBaseConfig({ transform: 'none',        topK: 10, reranker: 'pinecone', numChunks: 3 }) },
  { id: 'C3', label: 'HyDE + Rerank', desc: 'HyDE \u00b7 K=10 \u00b7 Pinecone rerank \u00b7 3 chunks',
    config: makeBaseConfig({ transform: 'hyde',        topK: 10, reranker: 'pinecone', numChunks: 3 }) },
  { id: 'C4', label: 'Multi-Query',   desc: 'Multi-query/3 \u00b7 K=10 \u00b7 Pinecone rerank \u00b7 5 chunks',
    config: makeBaseConfig({ transform: 'multi_query', topK: 10, reranker: 'pinecone', numChunks: 5, numVariants: 3 }) },
  { id: 'C5', label: 'Step-Back',     desc: 'Step-back \u00b7 K=5 \u00b7 No rerank \u00b7 3 chunks',
    config: makeBaseConfig({ transform: 'step_back',   topK: 5,  reranker: 'none',     numChunks: 3 }) },
];

// Deterministic retrieval metrics — no LLM call needed, just source URL matching
function computeRetrieval(chunks, expectedSources) {
  function isRelevant(chunk) {
    const src = chunk.metadata?.source || '';
    return expectedSources.some(es => src === es || src.includes(es.split('/').pop()));
  }

  // Binary relevance array
  const relArr = chunks.map(c => isRelevant(c) ? 1 : 0);

  // First hit rank (1-indexed, null if none)
  const firstHitIdx = relArr.indexOf(1);
  const firstHitRank = firstHitIdx === -1 ? null : firstHitIdx + 1;

  // Hit@K
  const hitAt1  = firstHitRank === 1;
  const hitAt3  = firstHitRank !== null && firstHitRank <= 3;
  const hitAt5  = firstHitRank !== null && firstHitRank <= 5;
  const hitAt10 = firstHitRank !== null && firstHitRank <= 10;

  // MRR
  const mrr = firstHitRank ? 1 / firstHitRank : 0;

  // Precision@K = (# relevant in top K) / K
  function precisionAtK(k) {
    const topK = relArr.slice(0, k);
    return topK.length ? topK.reduce((a, b) => a + b, 0) / topK.length : 0;
  }

  // Recall@K = (# unique expected sources found in top K) / total expected sources
  // Different from Hit@K when a question has multiple expected sources
  function recallAtK(k) {
    if (!expectedSources.length) return 0;
    const found = new Set();
    chunks.slice(0, k).forEach(c => {
      const src = c.metadata?.source || '';
      expectedSources.forEach(es => {
        if (src === es || src.includes(es.split('/').pop())) found.add(es);
      });
    });
    return found.size / expectedSources.length;
  }

  // NDCG@K with binary relevance
  // DCG@K = sum(rel_i / log2(i+2)) for i=0..K-1
  // IDCG@K = DCG of ideal ordering (all relevant docs at top positions)
  function ndcgAtK(k) {
    const topK = relArr.slice(0, k);
    const dcg = topK.reduce((acc, rel, i) => acc + rel / Math.log2(i + 2), 0);
    const numRelevant = Math.min(expectedSources.length, k);
    let idcg = 0;
    for (let i = 0; i < numRelevant; i++) idcg += 1 / Math.log2(i + 2);
    return idcg > 0 ? dcg / idcg : 0;
  }

  return {
    hit_at_1: hitAt1, hit_at_3: hitAt3, hit_at_5: hitAt5, hit_at_10: hitAt10,
    mrr, first_hit_rank: firstHitRank,
    precision_at_3: precisionAtK(3), precision_at_5: precisionAtK(5),
    recall_at_3: recallAtK(3),       recall_at_5: recallAtK(5),
    ndcg_at_3: ndcgAtK(3),           ndcg_at_5: ndcgAtK(5),
  };
}

async function judgeAnswer(query, context, answer, referenceAnswer) {
  const prompt = `You are evaluating a RAG system response. Return ONLY valid JSON, nothing else.

Question: ${query}

Reference answer (ground truth):
${referenceAnswer}

Retrieved context:
${context.slice(0, 2000)}

Generated answer:
${answer}

Score each dimension 0-10 and return JSON:

context_relevance (0-10): Are the retrieved chunks relevant to the question? Score 10 if every chunk directly addresses the question; score low if chunks are off-topic or only tangentially related.

faithfulness (0-10): Does the generated answer stay grounded in the retrieved context without hallucinating? Score 10 if every claim is supported by the context; deduct for each unsupported claim.

answer_correctness (0-10): Compared to the reference answer, how correct and complete is the generated answer? Score 10 if it captures all key facts from the reference; deduct for missing facts or inaccuracies.

answer_relevance (0-10): Does the generated answer actually address the question that was asked? Score 10 if fully on-topic; deduct if the answer is vague, off-topic, or refuses to answer.

Return: {"context_relevance": N, "faithfulness": N, "answer_correctness": N, "answer_relevance": N, "reasoning": "one sentence"}`;

  const text = await llmCall(prompt, 400);
  const match = text.match(/\{[\s\S]*\}/);
  const empty = { context_relevance: 0, faithfulness: 0, answer_correctness: 0, answer_relevance: 0, reasoning: 'parse error' };
  if (!match) return empty;
  try { return JSON.parse(match[0]); }
  catch { return empty; }
}

app.post('/api/eval', async (req, res) => {
  const { mode, config } = req.body;
  if (!PINECONE_HOST) return res.status(503).json({ error: 'Pinecone index not available' });
  if (!OPENAI_API_KEY || !ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'RAG dependencies missing' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch(e) {} };

  try {
    if (mode === 'single') {
      for (const item of EVAL_DATASET) {
        try {
          const result = await runPipeline(item.question, config);
          const [scores, retrieval] = await Promise.all([
            judgeAnswer(item.question, result.assembled_context, result.answer, item.reference),
            Promise.resolve(computeRetrieval(result.chunks, item.expected_sources)),
          ]);
          send({ type: 'result', questionId: item.id, question: item.question, answer: result.answer, scores, retrieval });
        } catch(e) {
          send({ type: 'error', questionId: item.id, error: e.message });
        }
      }
    } else if (mode === 'optimize') {
      const BATCH = 2;
      for (let i = 0; i < OPTIMIZE_PRESETS.length; i += BATCH) {
        await Promise.all(OPTIMIZE_PRESETS.slice(i, i + BATCH).map(async (preset) => {
          for (const item of EVAL_DATASET) {
            try {
              const result = await runPipeline(item.question, preset.config);
              const [scores, retrieval] = await Promise.all([
                judgeAnswer(item.question, result.assembled_context, result.answer, item.reference),
                Promise.resolve(computeRetrieval(result.chunks, item.expected_sources)),
              ]);
              send({ type: 'result', configId: preset.id, questionId: item.id, scores, retrieval });
            } catch(e) {
              send({ type: 'error', configId: preset.id, questionId: item.id, error: e.message });
            }
          }
        }));
      }
    }
    send({ type: 'done' });
  } catch(e) {
    send({ type: 'fatal', error: e.message });
  }
  res.end();
});

// ─── Start ───────────────────────────────────────────────────────────────────

resolveHosts().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🌲 Pinecone demo running → http://localhost:${PORT}\n`);
  });
});

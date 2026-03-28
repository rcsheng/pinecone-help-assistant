# PRD: Retrieval Configuration Explorer Tab

## Context

This project already has two working tabs:
1. **RAG Demo** — demonstrates retrieval-augmented generation against Pinecone docs
2. **Assistant** — demonstrates assistant/agent functionality

This PRD defines a third tab: **Retrieval Explorer** — an interactive tool that lets users configure, run, and compare the key levers that determine retrieval quality, spanning the full pipeline from ingest-time decisions through to context assembly.

The goal is educational and demonstrative: show concretely how each configuration choice affects what gets retrieved and why.

---

## Goals

- Make abstract retrieval concepts tangible by letting users see the effect of each configuration choice on real results
- Cover all six configuration layers: chunking, query transformation, index config, retrieval strategy, reranking, and context assembly
- Allow side-by-side comparison of configurations so users can see diffs, not just isolated results
- Reuse the existing Pinecone index and OpenAI/Claude backend already wired in the project

---

## Non-Goals

- This is not a production retrieval system — it is a demo/educational tool
- Do not rebuild or replace the existing RAG or Assistant tabs
- Do not implement Learning to Rank (LTR) — requires labeled training data not available in this demo context
- Do not implement evaluation metrics (Precision@K, Faithfulness, etc.) in this phase — that is a future tab

---

## Tab Structure

The tab is organized as a vertical flow:

```
[Query Input]
[Configuration Panel — 6 collapsible sections]
[Run Button]
[Results Panel — single or split view]
```

Users configure their pipeline, enter a query, run it, and see results. A "Compare Mode" toggle enables a split view with two independent configurations running against the same query simultaneously.

---

## Section 1: Chunking Strategy

> Controls how documents are split at ingest time. Since the demo uses a pre-built index, this section is **read-only / explanatory** by default, but should show what strategy was used and allow toggling between pre-indexed variants if multiple chunk strategies were indexed.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Strategy | Fixed-size, Recursive, Semantic, Late Chunking | Recursive |
| Chunk size | 256 / 512 / 1024 tokens | 512 |
| Chunk overlap | 0 / 10% / 20% | 10% |
| Enrichment | None, Contextual Prefix, Synthetic Queries | None |

### Implementation Notes

- If only one chunking strategy is indexed, render this section as an **informational callout** explaining what strategy is in use and what the tradeoffs are, rather than a live control
- If multiple chunk variants are indexed (recommended), allow switching between them and note that this changes which namespace is queried
- Display a **sample chunk** from the active configuration so users can see what the index actually contains

### UI

- Collapsible card with a "Chunking" header and a one-line summary of active settings (e.g., "Recursive · 512 tokens · 10% overlap")
- Inside: radio/select controls for each option
- Sample chunk viewer: a small code/text block showing an example chunk from the index with its metadata

---

## Section 2: Query Transformation

> Controls how the raw user query is modified before it hits the index. All transformations are **query-time and ephemeral** — nothing is stored.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Transformation | None, HyDE, Multi-Query, Step-Back, Query Decomposition | None |
| Number of variants (Multi-Query only) | 2 / 3 / 5 | 3 |

### Transformation Descriptions (render inline as helper text)

- **None**: Raw query sent directly to the index
- **HyDE**: An LLM generates a hypothetical answer to the query; that answer is embedded and used for retrieval instead of the query itself. Good for queries where user phrasing differs significantly from document phrasing.
- **Multi-Query**: The LLM generates N rephrased variants of the query. Each is retrieved independently; results are merged via RRF. Reduces sensitivity to exact wording.
- **Step-Back**: The LLM abstracts the query to a higher-level concept before retrieval (e.g., "ibuprofen side effects" → "NSAID side effects"). Useful for narrow queries that might miss broader relevant content.
- **Query Decomposition**: The LLM breaks a complex question into sub-questions, retrieves for each, then merges. Useful for multi-part questions.

### Implementation Notes

- When a transformation is active, show the **transformed query** (or queries) in the results panel before showing retrieved chunks — this is the most important educational moment
- HyDE requires an LLM call (OpenAI or Claude) before the Pinecone query
- Multi-Query requires N Pinecone queries; merge results with RRF before passing to reranking
- Step-Back and Decomposition require one LLM call to rewrite, then standard retrieval

### UI

- Radio group for transformation type
- Conditional input for Multi-Query variant count
- After running: expandable "Transformed Query" section showing what was actually sent to the index

---

## Section 3: Index Configuration

> Controls how the ANN search itself is executed. These map to Pinecone query parameters.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Top-K | 3 / 5 / 10 / 20 | 5 |
| Namespace filter | All / specific namespace if multiple exist | All |
| Metadata filter | None / by doc_type / by date_range | None |
| Include metadata in results | On / Off | On |

### Implementation Notes

- Top-K is the number of candidates retrieved before any reranking — communicate this clearly in the UI (label it "Candidate pool size" rather than just "Top-K" to make the role clear)
- If the index has meaningful metadata (doc_type, source URL, date), expose metadata filters as a structured form, not a raw JSON editor
- Namespace filter only appears if multiple namespaces exist in the index

### UI

- Slider or button group for Top-K
- Dropdown for namespace (hidden if only one namespace)
- Metadata filter builder: key/value dropdowns populated from known metadata fields

---

## Section 4: Retrieval Strategy

> Controls whether to use dense search, sparse search, or hybrid — and how to combine them.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Mode | Dense only, Sparse only, Hybrid | Hybrid |
| Fusion method (Hybrid only) | RRF, Weighted linear | RRF |
| Alpha / dense weight (Weighted only) | 0.0 – 1.0 slider | 0.7 |

### Implementation Notes

- Dense-only: standard Pinecone vector query
- Sparse-only: query using the sparse index only (requires SPLADE or BM25 vectors to have been indexed)
- Hybrid: run both, merge with selected fusion method
- RRF: standard reciprocal rank fusion — rank-based, no score calibration needed
- Weighted: linear combination of dense and sparse scores — requires scores to be on comparable scales; note this in the UI
- If the index doesn't have sparse vectors, disable sparse/hybrid options and show a tooltip explaining why

### UI

- Segmented control or radio group for mode
- Conditional controls for fusion method and alpha, only visible when Hybrid is selected
- For weighted alpha: labeled slider ("← Keyword · Semantic →") with 0.5 as the midpoint

---

## Section 5: Reranking

> Controls whether and how retrieved candidates are reranked before being passed to the LLM.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Reranker | None, Pinecone Rerank, Cohere Rerank 3, BGE Reranker v2 | None |
| Top-N after reranking | 1 / 2 / 3 / 5 | 3 |

### Implementation Notes

- Reranking takes the top-K candidates from Section 3 and re-scores them jointly with the query
- Top-N is the number of chunks passed to the LLM after reranking (N ≤ K from Section 3) — make this relationship explicit in the UI
- If Pinecone Rerank API is available, use it. Cohere and BGE require separate API calls.
- Show the **before and after ranking** in the results panel: this is the most educational output of the entire tab

### UI

- Dropdown for reranker selection
- Number input or button group for Top-N
- After running: show the initial ranking (from ANN) and the reranked order side by side, with position changes highlighted (e.g., "moved from #4 → #1")

---

## Section 6: Context Assembly

> Controls how retrieved chunks are assembled into the context window passed to the LLM for final answer generation.

### Configuration Options

| Option | Values | Default |
|--------|--------|---------|
| Number of chunks to include | 1 / 2 / 3 / 5 | 3 |
| Chunk ordering | As retrieved, Reversed, Relevant-first (ends) | As retrieved |
| Context compression | None, Summarize each chunk, Extract key sentences | None |
| Deduplication | Off / On | Off |
| Show raw context | Off / On | Off |

### Option Descriptions (render inline)

- **Chunk ordering**: Research ("Lost in the Middle", Liu et al.) shows LLMs attend most to content at the beginning and end of their context window. "Relevant-first (ends)" places the highest-ranked chunks at position 1 and last, with lower-ranked chunks in the middle.
- **Context compression**: Runs a secondary LLM pass over each chunk to extract only the portions relevant to the query before assembly. Reduces noise and token cost at the price of an extra LLM call.
- **Deduplication**: Removes chunks that are near-identical to a higher-ranked chunk (cosine similarity > 0.95). Common when multiple query variants (Section 2) retrieve overlapping content.
- **Show raw context**: Renders the exact text block sent to the LLM for final answer generation, including all formatting and chunk separators.

### Implementation Notes

- This section operates on the output of Section 5 (post-rerank) or Section 3 (if no reranker)
- Context compression requires an additional LLM call per chunk — flag this in the UI ("adds ~1s per chunk")
- "Show raw context" toggle should reveal a code block with the exact prompt context, not just the chunks — this is high-value for developers

### UI

- Number input or button group for chunk count
- Radio group for ordering
- Radio group for compression (with latency warning if non-None)
- Toggle for deduplication
- Toggle for "Show raw context" — reveals a read-only code block in the results panel

---

## Results Panel

### Single Mode

Three-zone layout:

1. **Query trace** (collapsible): Shows what actually happened — transformed query (if any), which namespaces were searched, number of candidates retrieved, reranker used
2. **Retrieved chunks**: Ordered list of chunks with metadata. Each chunk card shows: rank, relevance score, source, chunk text, and any score changes from reranking
3. **Generated answer**: The LLM's final answer synthesized from the assembled context. Uses existing Claude/OpenAI backend.

### Compare Mode

Side-by-side layout with Config A and Config B, both running against the same query. Each side shows its own chunk results and generated answer. A diff summary at the top highlights: number of overlapping chunks retrieved, answer similarity (rough), and key differences in configuration.

Compare Mode is activated by a toggle at the top of the Configuration Panel. When activated, each configuration section shows two columns (A and B). Config A defaults to the current settings; Config B defaults to all-default settings.

---

## State Management

- All configuration state lives in the frontend (no persistence required)
- Query and configuration are passed to the backend on each Run
- Backend executes the full pipeline per the configuration and returns: transformed query, raw candidates with scores, reranked candidates with scores, assembled context, generated answer
- Results are not cached — each Run is a fresh execution

---

## Backend API

Add a single new endpoint to the existing backend:

```
POST /api/retrieval-explorer

Request body:
{
  "query": string,
  "config": {
    "chunking": {
      "strategy": "recursive" | "fixed" | "semantic" | "late",
      "namespace": string | null
    },
    "query_transform": {
      "type": "none" | "hyde" | "multi_query" | "step_back" | "decompose",
      "num_variants": number  // for multi_query only
    },
    "index": {
      "top_k": number,
      "namespace_filter": string | null,
      "metadata_filter": object | null
    },
    "retrieval": {
      "mode": "dense" | "sparse" | "hybrid",
      "fusion": "rrf" | "weighted",
      "alpha": number  // 0.0–1.0, for weighted only
    },
    "reranking": {
      "model": "none" | "pinecone" | "cohere" | "bge",
      "top_n": number
    },
    "context": {
      "num_chunks": number,
      "ordering": "as_retrieved" | "reversed" | "relevant_ends",
      "compression": "none" | "summarize" | "extract",
      "deduplicate": boolean
    }
  }
}

Response body:
{
  "trace": {
    "original_query": string,
    "transformed_queries": string[],  // empty if no transformation
    "candidates_retrieved": number,
    "reranker_used": string | null
  },
  "chunks": [
    {
      "rank": number,
      "original_rank": number | null,  // rank before reranking, if reranked
      "score": number,
      "original_score": number | null,
      "text": string,
      "metadata": object
    }
  ],
  "assembled_context": string,  // exact text sent to LLM
  "answer": string
}
```

---

## Implementation Sequence

Build in this order — each step is independently testable:

1. **Tab scaffold**: Add the third tab to the navigation, render an empty panel
2. **Configuration UI**: Build all six collapsible sections with controls, no backend wiring yet — just log config state to console on Run
3. **Backend endpoint**: Implement `/api/retrieval-explorer` with dense-only, no transformation, no reranking as the baseline (Sections 3–4 defaults)
4. **Wire baseline**: Connect Run button to backend, render chunk results and answer
5. **Query transformation**: Add LLM calls for each transformation type; render transformed query in results
6. **Reranking**: Add reranker API calls; render before/after ranking in results
7. **Context assembly**: Add ordering, compression, deduplication logic; expose raw context toggle
8. **Compare Mode**: Add split-view toggle and dual-config UI

---

## Open Questions for Implementation

1. **How many chunking strategies are currently indexed?** If only one, Section 1 becomes informational only. If we want live chunking comparison, we need to index 2–3 namespace variants at setup time.
2. **Are sparse vectors indexed?** If not, disable sparse/hybrid in Section 4 with a tooltip.
3. **Which reranker APIs are available?** Confirm which of Pinecone Rerank, Cohere, and BGE are accessible in the current environment.
4. **LLM for transformations and compression**: Use the same model (Claude or OpenAI) already wired in the project, or a cheaper/faster model for intermediate calls?
5. **Compare Mode persistence**: Should Config A/B state survive a tab switch, or reset on leaving the tab?

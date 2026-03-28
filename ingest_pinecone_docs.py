"""
Pinecone Docs Ingest Script
============================
Scrapes key Pinecone documentation pages, chunks them, embeds with
OpenAI text-embedding-3-small, and upserts into a Pinecone index.

Usage:
    pip install pinecone openai requests beautifulsoup4 tiktoken
    python ingest_pinecone_docs.py

Set env vars (or edit the KEY section below):
    PINECONE_API_KEY=...
    OPENAI_API_KEY=...
"""

import os
import re
import time
import json
import hashlib
import requests
from bs4 import BeautifulSoup
from openai import OpenAI
from pinecone import Pinecone, ServerlessSpec

from dotenv import load_dotenv
load_dotenv(override=True)

# ─── CONFIG ──────────────────────────────────────────────────────────────────

PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY", "YOUR_PINECONE_KEY")
OPENAI_API_KEY   = os.environ.get("OPENAI_API_KEY",   "YOUR_OPENAI_KEY")

INDEX_NAME   = "pinecone-docs-demo"
EMBED_MODEL  = "text-embedding-3-small"
EMBED_DIM    = 1536
CHUNK_SIZE   = 400   # tokens (approximate, using word-based split)
CHUNK_OVERLAP = 60
BATCH_SIZE   = 96

# Pages to ingest — covers the core concepts the demo queries against
DOCS_URLS = [
    # Overview & architecture
    "https://docs.pinecone.io/guides/get-started/overview",
    "https://docs.pinecone.io/guides/get-started/key-concepts",
    # Indexes
    "https://docs.pinecone.io/guides/indexes/understanding-indexes",
    "https://docs.pinecone.io/guides/indexes/create-an-index",
    "https://docs.pinecone.io/guides/indexes/pods-vs-serverless",
    # Data
    "https://docs.pinecone.io/guides/data/upsert-data",
    "https://docs.pinecone.io/guides/data/query-data",
    "https://docs.pinecone.io/guides/data/filter-with-metadata",
    "https://docs.pinecone.io/guides/data/understanding-namespaces",
    # Search
    "https://docs.pinecone.io/guides/search/dense-vector-search",
    "https://docs.pinecone.io/guides/search/sparse-vector-search",
    "https://docs.pinecone.io/guides/search/hybrid-search",
    "https://docs.pinecone.io/guides/search/rerank",
    # Inference
    "https://docs.pinecone.io/guides/inference/understanding-inference",
    "https://docs.pinecone.io/guides/inference/generate-embeddings",
    # Assistant
    "https://docs.pinecone.io/guides/assistant/overview",
    # Concepts
    "https://docs.pinecone.io/reference/api/introduction",
]

# ─── SCRAPING ────────────────────────────────────────────────────────────────

def scrape_page(url: str) -> dict | None:
    """Fetch a Pinecone docs page and return cleaned text + metadata."""
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; PineconeDemo/1.0)"}
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ⚠ Failed to fetch {url}: {e}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Remove nav, header, footer, code blocks, and inline code (keep prose)
    for tag in soup(["nav", "header", "footer", "script", "style", "svg", "pre", "code"]):
        tag.decompose()

    # Try to grab the main content area
    main = (
        soup.find("main") or
        soup.find("article") or
        soup.find("div", class_=re.compile(r"content|prose|docs", re.I)) or
        soup.body
    )

    if not main:
        return None

    # Extract title
    title_tag = soup.find("h1")
    title = title_tag.get_text(strip=True) if title_tag else url.split("/")[-1]

    # Get clean text
    text = main.get_text(separator=" ", strip=True)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()

    if len(text) < 100:
        print(f"  ⚠ Too short, skipping: {url}")
        return None

    print(f"  ✓ {title[:60]} ({len(text)} chars)")
    return {"url": url, "title": title, "text": text}


# ─── CHUNKING ────────────────────────────────────────────────────────────────

def chunk_text(text: str, source_url: str, title: str,
               chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[dict]:
    """Split text into overlapping word-based chunks with metadata."""
    words = text.split()
    chunks = []
    start = 0

    while start < len(words):
        end = start + chunk_size
        chunk_words = words[start:end]
        chunk_text_str = " ".join(chunk_words)

        chunk_id = hashlib.md5(f"{source_url}:{start}".encode()).hexdigest()[:16]

        chunks.append({
            "id": chunk_id,
            "text": chunk_text_str,
            "metadata": {
                "source": source_url,
                "title": title,
                "chunk_index": len(chunks),
                "char_count": len(chunk_text_str),
            }
        })

        if end >= len(words):
            break
        start += chunk_size - overlap

    return chunks


# ─── EMBEDDING ───────────────────────────────────────────────────────────────

def embed_texts(texts: list[str], client: OpenAI) -> list[list[float]]:
    """Embed a batch of texts using OpenAI."""
    response = client.embeddings.create(
        input=texts,
        model=EMBED_MODEL,
    )
    return [item.embedding for item in response.data]


# ─── PINECONE UPSERT ─────────────────────────────────────────────────────────

def upsert_chunks(chunks: list[dict], embeddings: list[list[float]], index) -> int:
    """Upsert vectors in batches into Pinecone."""
    vectors = [
        {
            "id": chunk["id"],
            "values": emb,
            "metadata": {**chunk["metadata"], "text": chunk["text"]},
        }
        for chunk, emb in zip(chunks, embeddings)
    ]

    upserted = 0
    for i in range(0, len(vectors), BATCH_SIZE):
        batch = vectors[i : i + BATCH_SIZE]
        index.upsert(vectors=batch)
        upserted += len(batch)
        print(f"    Upserted {upserted}/{len(vectors)} vectors...")

    return upserted


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("\n🌲 Pinecone Docs Ingest\n" + "="*40)

    # Init clients
    pc = Pinecone(api_key=PINECONE_API_KEY)
    oai = OpenAI(api_key=OPENAI_API_KEY)

    # Create or connect to index
    existing = [idx.name for idx in pc.list_indexes()]
    if INDEX_NAME not in existing:
        print(f"\n📦 Creating index '{INDEX_NAME}'...")
        pc.create_index(
            name=INDEX_NAME,
            dimension=EMBED_DIM,
            metric="cosine",
            spec=ServerlessSpec(cloud="aws", region="us-east-1")
        )
        # Wait for index to be ready
        while not pc.describe_index(INDEX_NAME).status["ready"]:
            print("  Waiting for index to be ready...")
            time.sleep(2)
        print("  ✓ Index ready")
    else:
        print(f"\n📦 Using existing index '{INDEX_NAME}'")

    index = pc.Index(INDEX_NAME)

    # Scrape
    print(f"\n🔍 Scraping {len(DOCS_URLS)} pages...")
    all_chunks = []
    for url in DOCS_URLS:
        print(f"\n  → {url.split('/')[-1]}")
        page = scrape_page(url)
        if not page:
            continue
        chunks = chunk_text(page["text"], page["url"], page["title"])
        print(f"    {len(chunks)} chunks")
        all_chunks.extend(chunks)
        time.sleep(0.3)  # polite rate limiting

    print(f"\n✂️  Total chunks: {len(all_chunks)}")

    # Embed in batches
    print(f"\n🔢 Embedding with {EMBED_MODEL}...")
    all_embeddings = []
    texts = [c["text"] for c in all_chunks]

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        embs = embed_texts(batch, oai)
        all_embeddings.extend(embs)
        print(f"  Embedded {min(i+BATCH_SIZE, len(texts))}/{len(texts)}")
        time.sleep(0.1)

    # Upsert
    print(f"\n⬆️  Upserting to Pinecone...")
    total = upsert_chunks(all_chunks, all_embeddings, index)

    # Save manifest for reference
    manifest = {
        "index_name": INDEX_NAME,
        "embed_model": EMBED_MODEL,
        "embed_dim": EMBED_DIM,
        "total_chunks": total,
        "pages_scraped": len(DOCS_URLS),
        "chunk_size": CHUNK_SIZE,
        "chunk_overlap": CHUNK_OVERLAP,
    }
    with open("ingest_manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n✅ Done! {total} vectors in '{INDEX_NAME}'")
    print(f"   Manifest saved to ingest_manifest.json")
    print(f"\n   Next: open pinecone_rag_demo.html and enter your keys.\n")


if __name__ == "__main__":
    main()

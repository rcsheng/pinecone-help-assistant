"""
Pinecone Assistant Ingest Script
==================================
Scrapes each URL in DOCS_URLS as a complete page, saves it as a .txt file
with metadata (url, guides, section, slug), and uploads to a Pinecone Assistant.

Usage:
    pip install "pinecone[assistant]>=8.0.0" requests beautifulsoup4 python-dotenv
    python pinecone_assistant_ingest.py

Set env vars (or use a .env file):
    PINECONE_API_KEY=...
"""

import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from pinecone import Pinecone

from dotenv import load_dotenv
load_dotenv(override=True)

# Reuse scraping from the existing ingest script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ingest_pinecone_docs import scrape_page, DOCS_URLS

# ─── CONFIG ──────────────────────────────────────────────────────────────────

PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY", "YOUR_PINECONE_KEY")
ASSISTANT_NAME   = "pinecone-help"
DOCS_DIR         = "assistant_docs"

ASSISTANT_INSTRUCTIONS = (
    "You are a Pinecone documentation assistant. "
    "Answer questions about Pinecone based on the official documentation. "
    "Be precise and technical. When relevant, mention the specific feature, "
    "API, or concept that answers the user's question."
)


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def parse_url_meta(url: str) -> dict:
    """Extract guides, section, and slug from a Pinecone docs URL."""
    path_parts = urlparse(url).path.strip("/").split("/")
    # e.g. ['guides', 'get-started', 'overview']
    #      ['reference', 'api', 'introduction']
    slug    = path_parts[-1]
    guides  = path_parts[0] == "guides"
    section = path_parts[1] if len(path_parts) > 1 else path_parts[0]
    return {"guides": guides, "section": section, "slug": slug}


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("\n🌲 Pinecone Assistant Ingest\n" + "=" * 40)

    pc = Pinecone(api_key=PINECONE_API_KEY)

    # Create or connect to assistant
    existing_names = [a.name for a in pc.assistant.list_assistants()]
    if ASSISTANT_NAME not in existing_names:
        print(f"\n🤖 Creating assistant '{ASSISTANT_NAME}'...")
        assistant = pc.assistant.create_assistant(
            assistant_name=ASSISTANT_NAME,
            instructions=ASSISTANT_INSTRUCTIONS,
            region="us",
            timeout=60,
        )
        print(f"  ✓ Assistant ready (status: {assistant.status})")
    else:
        print(f"\n🤖 Using existing assistant '{ASSISTANT_NAME}'")
        assistant = pc.assistant.Assistant(assistant_name=ASSISTANT_NAME)

    # Clean out old chunk files
    docs_path = Path(DOCS_DIR)
    docs_path.mkdir(exist_ok=True)
    old_files = list(docs_path.glob("*.txt"))
    if old_files:
        print(f"\n🗑  Deleting {len(old_files)} existing file(s) from {DOCS_DIR}/...")
        for f in old_files:
            f.unlink()

    # Scrape and save one file per URL
    print(f"\n🔍 Scraping {len(DOCS_URLS)} pages...")
    saved = []

    for url in DOCS_URLS:
        meta = parse_url_meta(url)
        print(f"\n  → {meta['slug']}")
        page = scrape_page(url)
        if not page:
            continue

        filename = f"{meta['slug']}.txt"
        content = (
            f"URL: {url}\n"
            f"Title: {page['title']}\n"
            f"Section: {meta['section']}\n"
            f"Guides: {meta['guides']}\n"
            f"Slug: {meta['slug']}\n"
            f"\n"
            f"{page['text']}"
        )
        filepath = docs_path / filename
        filepath.write_text(content, encoding="utf-8")
        saved.append((filepath, {**meta, "url": url, "title": page["title"]}))
        print(f"    ✓ saved ({len(page['text'])} chars)")
        time.sleep(0.3)

    print(f"\n💾 Saved {len(saved)} page files to {DOCS_DIR}/")

    # Upload to assistant
    print(f"\n⬆️  Uploading to Pinecone Assistant '{ASSISTANT_NAME}'...")
    uploaded = 0
    failed   = 0

    for filepath, metadata in saved:
        try:
            assistant.upload_file(
                file_path=str(filepath),
                metadata=metadata,
                timeout=None,
            )
            uploaded += 1
            print(f"  [{uploaded}/{len(saved)}] {filepath.name}")
        except Exception as e:
            print(f"  ⚠ Failed {filepath.name}: {e}")
            failed += 1

    print(f"\n✅ Done! Uploaded {uploaded} pages to assistant '{ASSISTANT_NAME}'")
    if failed:
        print(f"   ⚠ {failed} failed uploads")
    print(f"\n   Files are being indexed — wait a minute before chatting.")
    print(f"   Next: python pinecone_assistant_chat.py\n")
    input("Press Enter to exit...")


if __name__ == "__main__":
    main()

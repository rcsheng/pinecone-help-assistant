"""
Pinecone Multimodal Assistant Ingest
======================================
Demonstrates the Pinecone Assistant multimodal context API by uploading a PDF
with multimodal=True, which enables image/chart extraction, OCR, and caption
generation alongside the standard text content.

Multimodal upload differences vs standard upload:
  - Images, charts, and diagrams are extracted and captioned
  - OCR is applied to scanned/image-only pages
  - Token usage during chat is higher (images count toward context)
  - Decorative images (logos, backgrounds) are automatically filtered out
  - Citation responses will NOT include highlight fields

Usage:
    pip install "pinecone[assistant]>=8.0.0" python-dotenv
    python pinecone_multimodal_ingest.py

Set env vars (or use a .env file):
    PINECONE_API_KEY=...

Docs: https://docs.pinecone.io/guides/assistant/multimodal
"""

import os
import sys
from pathlib import Path

from pinecone import Pinecone
from dotenv import load_dotenv

load_dotenv(override=True)

# ─── CONFIG ──────────────────────────────────────────────────────────────────

PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY", "YOUR_PINECONE_KEY")
ASSISTANT_NAME   = "pinecone-help"
PDF_PATH         = Path(__file__).parent / "Multimodal_Search_Pinecone_AWS_Whitepaper.pdf"


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("\n🌲 Pinecone Multimodal Ingest\n" + "=" * 40)

    if not PDF_PATH.exists():
        print(f"  ✗ PDF not found: {PDF_PATH}")
        sys.exit(1)

    pc = Pinecone(api_key=PINECONE_API_KEY)

    # Connect to the existing assistant (created by pinecone_assistant_ingest.py)
    existing_names = [a.name for a in pc.assistant.list_assistants()]
    if ASSISTANT_NAME not in existing_names:
        print(f"  ✗ Assistant '{ASSISTANT_NAME}' not found.")
        print(f"    Run pinecone_assistant_ingest.py first to create it.")
        sys.exit(1)

    assistant = pc.assistant.Assistant(assistant_name=ASSISTANT_NAME)
    print(f"\n🤖 Connected to assistant '{ASSISTANT_NAME}'")

    # ── Upload with multimodal=True ───────────────────────────────────────────
    # Setting multimodal=True enables:
    #   - Image and chart extraction from PDF pages
    #   - Automatic caption and keyword generation for each image
    #   - OCR for scanned/image-only pages
    #   - Filtering of decorative images (logos, backgrounds, stock photos)
    # Note: multimodal PDFs count toward a separate per-assistant limit
    #   Starter: 10 files · Standard/Enterprise: 20 files
    print(f"\n📄 Uploading '{PDF_PATH.name}' with multimodal=True...")
    print(f"   (Images, charts, and diagrams will be extracted and captioned)")

    response = assistant.upload_file(
        file_path=str(PDF_PATH),
        metadata={
            "title": "Multimodal Search with Pinecone and AWS",
            "type": "whitepaper",
            "multimodal": True,
        },
        multimodal=True,
        timeout=None,  # wait until processing is complete
    )

    print(f"\n✅ Upload complete!")
    print(f"   File ID  : {response.id}")
    print(f"   Name     : {response.name}")
    print(f"   Status   : {response.status}")
    print(f"   Multimodal: {getattr(response, 'multimodal', True)}")

    # ── Demo: context query with multimodal=True ──────────────────────────────
    # The context endpoint retrieves ranked snippets for a query.
    # With multimodal=True, image snippets (ImageBlock) are returned alongside
    # text snippets (TextBlock). Each ImageBlock includes:
    #   - caption: auto-generated description of the image
    #   - image.data: base64-encoded image bytes (when include_binary_content=True)
    #   - image.mime_type: e.g. "image/png"
    # Set include_binary_content=False to get captions only (lower token cost).
    print(f"\n🔍 Querying context (multimodal) for a sample question...")

    sample_query = "How does multimodal search combine images and text in Pinecone?"

    context = assistant.context(
        query=sample_query,
        multimodal=True,
        include_binary_content=False,  # captions only — set True to get base64 image data
    )

    print(f"\n   Query   : {sample_query}")
    print(f"   Snippets: {len(context.snippets)}\n")

    for i, snippet in enumerate(context.snippets[:5], 1):
        snippet_type = getattr(snippet, "type", "unknown")
        score        = getattr(snippet, "score", None)
        ref          = getattr(snippet, "reference", None)
        pages        = getattr(ref, "pages", []) if ref else []

        score_str = f"{score:.4f}" if score is not None else "N/A"
        print(f"   [{i}] type={snippet_type}  score={score_str}  pages={pages}")

        content = getattr(snippet, "content", None)
        if snippet_type == "text" and content:
            text = getattr(content, "text", "") or ""
            print(f"       {text[:200].strip()}{'…' if len(text) > 200 else ''}")
        elif snippet_type == "image" and content:
            caption = getattr(content, "caption", "(no caption)")
            print(f"       caption: {caption}")
        print()

    print("   Next: run python pinecone_assistant_chat.py to ask questions")
    print("         about the whitepaper alongside the existing docs.\n")
    input("Press Enter to exit...")


if __name__ == "__main__":
    main()

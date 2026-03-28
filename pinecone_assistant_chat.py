"""
Pinecone Assistant Chat
========================
Interactive REPL for the Pinecone help assistant.
Maintains conversation history and shows source citations.

Usage:
    pip install "pinecone[assistant]>=8.0.0"
    python pinecone_assistant_chat.py

Set env vars:
    PINECONE_API_KEY=...
"""

import os

from dotenv import load_dotenv
load_dotenv(override=True)

from pinecone import Pinecone
from pinecone_plugins.assistant.models.chat import Message

# ─── CONFIG ──────────────────────────────────────────────────────────────────

PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY", "YOUR_PINECONE_KEY")
ASSISTANT_NAME   = "pinecone-help"


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    pc = Pinecone(api_key=PINECONE_API_KEY)
    assistant = pc.assistant.Assistant(assistant_name=ASSISTANT_NAME)

    print(f"\n🌲 Pinecone Help Assistant")
    print(f"   Assistant : {ASSISTANT_NAME}")
    print(f"   Type 'quit' or 'exit' to quit, 'clear' to reset history.\n")

    history: list[Message] = []

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit", "q"):
            print("Goodbye!")
            break

        if user_input.lower() == "clear":
            history.clear()
            print("  (conversation history cleared)\n")
            continue

        history.append(Message(role="user", content=user_input))

        try:
            response = assistant.chat(
                messages=history,
                stream=False,
                context_options={
                    "multimodal": True,
                    "include_binary_content": False,  # captions only; set True for base64 image data
                },
            )
        except Exception as e:
            print(f"  ⚠ Error: {e}\n")
            history.pop()  # don't keep the unanswered message
            continue

        answer = response.message.content
        history.append(Message(role="assistant", content=answer))

        print(f"\nAssistant: {answer}\n")

        # Show citations when available
        citations = getattr(response, "citations", None)
        if citations:
            seen = set()
            sources = []
            for citation in citations:
                for ref in getattr(citation, "references", []):
                    name = getattr(getattr(ref, "file", None), "name", None)
                    if name and name not in seen:
                        seen.add(name)
                        sources.append(name)
            if sources:
                print("Sources:")
                for src in sources:
                    print(f"  - {src}")
                print()


if __name__ == "__main__":
    main()

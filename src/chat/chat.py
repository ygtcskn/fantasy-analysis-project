"""Chat with the Fantezi Analiz assistant in the terminal.

Step 4 of the chatbot guide (docs/chatbot/04-connect-the-ai.md).

    python src/chat/chat.py                    # Claude (Anthropic)
    python src/chat/chat.py --provider openai  # ChatGPT's model (OpenAI)

Type a question and press Enter. Type "çıkış" (or "exit") to stop.
Every question costs a little money on the provider's account.
"""
import argparse
import importlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.tools import open_database  # noqa: E402

PROVIDERS = {"claude": "src.chat.claude_agent", "openai": "src.chat.openai_agent"}
QUIT_WORDS = {"çıkış", "cikis", "exit", "quit"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider", choices=list(PROVIDERS), default="claude")
    args = parser.parse_args()
    # Windows terminals may not print Turkish letters without this.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    agent = importlib.import_module(PROVIDERS[args.provider])
    client = agent.make_client()
    db = open_database()
    messages = []
    total = 0.0
    print(f"Fantezi Analiz asistanı ({agent.MODEL}). Bir soru yaz; çıkmak için 'çıkış' yaz.\n")
    try:
        while True:
            try:
                question = input("Sen: ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not question:
                continue
            if question.lower() in QUIT_WORDS:
                break
            before = len(messages)
            try:
                reply = agent.ask(client, db, messages, question)
            except agent.ApiError as error:
                del messages[before:]
                status = getattr(error, "status_code", None)
                if status in (401, 403):
                    raise SystemExit(f"The API key was refused. Check {agent.KEY_NAME} in .env.") from None
                print(f"API error {status or ''}: {getattr(error, 'message', error)}\n")
                continue
            total += reply.cost_usd
            print(f"\nAsistan: {reply.text}\n")
            print(f"  [{reply.model} | tools: {', '.join(reply.tool_calls) or 'none'} | {reply.rounds} rounds | "
                  f"{reply.input_tokens} in / {reply.output_tokens} out tokens | "
                  f"${reply.cost_usd:.4f}, total ${total:.4f}]\n")
    finally:
        db.close()


if __name__ == "__main__":
    main()
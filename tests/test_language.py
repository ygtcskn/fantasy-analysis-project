"""The website's two languages. Every text is written in Turkish where it is used and
src/web/core/english.js holds its English: these checks keep the two in step, so a new
Turkish text cannot reach an English page untranslated without a test saying so.
No browser and no Node: the scripts and pages are read as text."""
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "src" / "web"
PAGES = ("index.html", "team.html", "404.html")
STRING = r'"(?:[^"\\\n]|\\.)*"'
PLACEHOLDER = re.compile(r"\{(\w+)\}")
TURKISH_LETTER = re.compile("[çğıöşüÇĞİÖŞÜâ]")


def read(path):
    return path.read_text(encoding="utf-8")


def english_entries():
    """english.js as [(Turkish, [English forms])]. It keeps one entry per line."""
    entries = []
    for line in read(WEB / "core" / "english.js").splitlines():
        match = re.match(rf"^\s*({STRING})\s*:\s*(.+?),?\s*$", line)
        if match:
            value = json.loads(match[2])
            entries.append((json.loads(match[1]), value if isinstance(value, list) else [value]))
    return entries


def scripts():
    return [path for path in sorted(WEB.rglob("*.js")) if path.name != "english.js"]


class PageText(HTMLParser):
    """The text and labels of a page that core/language.js would translate."""

    LABELS = ("title", "aria-label", "placeholder", "alt")
    VOID = {"br", "img", "input", "meta", "link", "col", "path", "circle"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.open, self.found, self.in_body = [], [], False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.in_body = self.in_body or tag == "body"
        if tag not in self.VOID:
            self.open.append((tag, attrs))
        if self.in_body:
            self.found += [" ".join(attrs[name].split()) for name in self.LABELS
                           if attrs.get(name) and f"data-en-{name}" not in attrs]

    def handle_endtag(self, tag):
        while self.open and self.open.pop()[0] != tag:
            pass

    def handle_data(self, data):
        text = " ".join(data.split())
        if self.in_body and text and self.open:
            tag, attrs = self.open[-1]
            # An element with data-en carries its own English; <code> is a command or a file name.
            if tag not in ("script", "style", "code") and "data-en" not in attrs:
                self.found.append(text)


class EnglishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = english_entries()
        cls.english = dict(cls.entries)

    def test_each_turkish_text_is_entered_once(self):
        keys = [key for key, _ in self.entries]
        self.assertGreater(len(keys), 1000)
        self.assertEqual(sorted(key for key in set(keys) if keys.count(key) > 1), [])

    def test_every_text_a_script_shows_has_english(self):
        missing = set()
        for path in scripts():
            # t("…") shows a text; knownText("…") a server's. t({ tr, en }) carries its own English.
            for literal in re.findall(rf"(?<![\w.$])(?:t|knownText)\(\s*({STRING})", read(path)):
                text = json.loads(literal)
                # core/language.js explains t("…") in a comment.
                if text not in self.english and text != "…":
                    missing.add(f"{path.relative_to(WEB).as_posix()}: {text}")
        self.assertEqual(sorted(missing), [])

    def test_every_match_event_has_english(self):
        table = re.search(r"const EVENT_TEXT = \{(.*?)\n\};", read(WEB / "core" / "locale.js"), re.S)[1]
        events = [json.loads(value) for _, value in re.findall(rf"({STRING})\s*:\s*({STRING})", table)]
        self.assertGreater(len(events), 60)
        self.assertEqual(sorted(text for text in set(events) if text not in self.english), [])

    def test_every_text_written_in_a_page_has_english(self):
        # A sentence with markup inside it is entered whole, with its HTML.
        with_markup = [key for key in self.english if "<" in key and ">" in key]
        missing = set()
        for name in PAGES:
            page = PageText()
            page.feed(read(WEB / name))
            self.assertGreater(len(page.found), 5, name)
            for text in page.found:
                # A name written the same in both languages (CSV, Claude) is entered as itself.
                if not re.search(r"[^\W\d_]{2}", text) or text in self.english:
                    continue
                if not any(text in key for key in with_markup):
                    missing.add(f"{name}: {text}")
        self.assertEqual(sorted(missing), [])

    def test_english_keeps_the_values_the_turkish_names(self):
        wrong = [key for key, forms in self.entries
                 if any(set(PLACEHOLDER.findall(form)) != set(PLACEHOLDER.findall(key)) for form in forms)]
        self.assertEqual(wrong, [])
        # A pair is "exactly one" and "any other number", so it needs something to count.
        self.assertEqual([key for key, forms in self.entries if len(forms) > 1 and "{count}" not in key], [])
        self.assertEqual([key for key, forms in self.entries if len(forms) not in (1, 2) or not all(forms)], [])

    def test_what_the_servers_say_has_english(self):
        # The chat and live-score servers word their own messages in Turkish; the page shows
        # the English kept for them (knownText). The AI's prompt is not a message.
        sources = [ROOT / "src" / "chat" / "web_chat.py", ROOT / "src" / "chat" / "assistant.py",
                   ROOT / "functions" / "api" / "chat.js", ROOT / "src" / "web" / "serve.py",
                   ROOT / "src" / "web" / "live.py", *sorted((ROOT / "src" / "chat" / "cloud").glob("*.js"))]
        missing = set()
        for path in sources:
            text = re.sub(r'SYSTEM_PROMPT = """.*?"""', "", read(path), flags=re.S)
            text = re.sub(r"const SYSTEM_PROMPT_LINES = \[.*?\n\];", "", text, flags=re.S)
            for literal in re.findall(STRING, text):
                try:
                    message = json.loads(literal)
                except ValueError:
                    continue  # A pattern such as "\d{4}" is not a sentence anyone reads.
                # A value filled in later ({name}) is checked below, with its values.
                if TURKISH_LETTER.search(message) and message[-1:] in ".?" and "{" not in message:
                    if message not in self.english:
                        missing.add(f"{path.relative_to(ROOT).as_posix()}: {message}")
        self.assertEqual(sorted(missing), [])
        limit = re.search(r"^MAX_QUESTION_CHARS = (\d+)", read(ROOT / "src" / "chat" / "web_chat.py"), re.M)[1]
        self.assertIn(f"Soru en fazla {limit} karakter olabilir.", self.english)
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            for message in (f"API anahtarı eksik: Cloudflare'de {key} ekleyin.",
                            f"API anahtarı reddedildi: Cloudflare'deki {key} değerini kontrol edin.",
                            f"API anahtarı eksik: .env dosyasına {key} ekleyin.",
                            f"API anahtarı reddedildi: .env dosyasındaki {key} değerini kontrol edin."):
                self.assertIn(message, self.english)

    def test_no_script_writes_the_turkish_format_itself(self):
        # Numbers, dates and sorting follow LOCALE (core/language.js), never a fixed "tr-TR".
        fixed = [path.relative_to(WEB).as_posix() for path in scripts() if path.name != "language.js"
                 and re.search(r'"tr-TR"|localeCompare\([^)]*"tr"\)|Case\("tr"\)', read(path))]
        self.assertEqual(fixed, [])

    def test_every_page_loads_the_language_first(self):
        for name in PAGES:
            sources = re.findall(r'<script src="([^"]+)"', read(WEB / name))
            self.assertEqual(sources[:2], ["core/english.js", "core/language.js"], name)
            self.assertIn('<html lang="en"', read(WEB / name))


if __name__ == "__main__":
    unittest.main()

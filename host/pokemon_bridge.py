#!/usr/bin/env python3
"""PokeDex companion for the ESP32-S3 AMOLED card lookup.

Receives microphone audio from the board, recognizes the card name with local
Whisper (English) by choosing among the catalog's card names, searches the
vintage card catalog from the pokemon-website project, and streams card
artwork back as RGB565.

The board reaches it over USB serial, or with --listen over a WebSocket (the
Wi-Fi firmware build). Both links carry the same newline-separated protocol;
over the network each text frame holds bytes of it, and the board presents a
shared token (X-PokeDex-Token header or ?token=; a wrong one is closed 4001).

Protocol v2 (mirrors firmware main/pokemon_lookup.c):
  ESP32 -> Mac:  @HELLO <version>                        (board booted)
                 @VOICE <n> / @DATA <b64> ... / @END   (PCM16 mono 16 kHz)
                 @QUERY <b64 typed text>
                 @GETIMG <cardId>
  Mac -> ESP32:  @READY <version>
                 @ERROR <b64 message>
                 @TEXT <b64 transcript>
                 @RESULT <b64 json {transcript, matches:[...]}>
                 @IMG <cardId> <w> <h> + @DATA <b64 rgb565> ... + @IMGEND <cardId>
                 @IMGERR <cardId>
                 @TEST <command>                         (test hooks: handle_test_command)
  ESP32 -> Mac:  @SNAP <w> <h> <stride> / @SNAPDATA <b64> ... / @SNAPEND
                                                         (screen capture, for @TEST SNAPSHOT)
"""
import argparse
import asyncio
import base64
import hmac
import difflib
import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import serial
from serial.tools import list_ports
from PIL import Image, ImageDraw

try:
    import mlx.core as mx
    import mlx_whisper
    from mlx_whisper import load_models
    from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.tokenizer import get_tokenizer
except ImportError:
    mlx_whisper = None

ESPRESSIF_VID = 0x303A
ESPRESSIF_PID = 0x1001
PROTOCOL_VERSION = 2
SAMPLE_RATE = 16000
DEFAULT_MODEL = "mlx-community/whisper-small.en-mlx"

IMG_WIDTH = 194
IMG_HEIGHT = 272
MAX_MATCHES = 50          # catalog search limit
MAX_SENT_MATCHES = 10     # user preference: up to 10 options per lookup

NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18",
    "nineteen": "19", "twenty": "20", "thirty": "30", "forty": "40",
    "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80",
    "ninety": "90", "hundred": "100",
}

# Words that carry little meaning in a spoken card lookup
FILLER_WORDS = {"set", "card", "cards", "pokemon", "holo", "holofoil",
                "promo", "edition", "rare", "version"}

# Conversational words Whisper transcribes around the card name
# ("Show me the Charizard", "Umm, Blastoise"). Dropped before matching.
STOP_WORDS = {"a", "an", "the", "of", "and", "or", "to", "for", "in", "on", "with",
              "show", "me", "find", "search", "look", "up", "get", "give", "please",
              "i", "im", "want", "need", "have", "got", "my", "is", "it", "its", "this",
              "that", "what", "whats", "how", "much", "price", "value", "worth",
              "um", "umm", "uh", "uhh", "hmm", "er", "ah", "oh", "okay", "ok", "so",
              "like", "just", "can", "you", "hey", "hi", "thank", "thanks", "bye"}

# Filler a spoken lookup may open with ("Show me the ...", "Um, ..."). Stricter
# than STOP_WORDS: short words like "on", "of", "oh" are often the start of a
# misheard name ("Onix" -> "on eggs").
LEAD_WORDS = {"show", "me", "the", "find", "search", "look", "up", "for", "get", "give",
              "please", "i", "want", "need", "um", "umm", "uh", "uhh", "hmm", "er", "ah",
              "okay", "ok", "so", "hey", "hi", "can", "you", "what", "whats", "is", "like"}


def normalize_text(value) -> str:
    """Lowercase, straight quotes, accents stripped ("Pokémon" -> "pokemon")."""
    text = unicodedata.normalize("NFKD", str(value or "").replace("’", "'"))
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def normalize_number(value) -> str:
    raw = str(value or "").strip()
    return raw.lstrip("0") if raw else ""


def tokenize_query(query: str, join=lambda tokens: tokens):
    """Split a query into (text tokens, card-number tokens). `join` merges
    words Whisper split apart ("mew two", "ho oh") before number words are
    turned into digits."""
    text = normalize_text(query)
    text = re.sub(r"'s\b", "", text)  # "Blaine's" -> "Blaine", "Charizard's" -> "Charizard"
    tokens = join(re.findall(r"[a-z0-9]+", text))
    tokens = [NUMBER_WORDS.get(t, t) for t in tokens]
    numeric_tokens = [t.lstrip("0") or "0" for t in tokens if t.isdigit()]
    text_tokens = [t for t in tokens if not t.isdigit()]
    if text_tokens and any(t not in FILLER_WORDS for t in text_tokens):
        text_tokens = [t for t in text_tokens if t not in FILLER_WORDS]
    return text_tokens, numeric_tokens


class Catalog:
    """Vintage card index built from pokemon-website set JSON files."""

    def __init__(self, website_root: Path, era_ids):
        eras_file = website_root / "src" / "data" / "eras.json"
        sets_dir = website_root / "public" / "data" / "sets"
        with open(eras_file, encoding="utf-8") as handle:
            eras = json.load(handle)["eras"]

        wanted_sets = []
        for era in eras:
            if era["id"] not in era_ids:
                continue
            wanted_sets.extend(era.get("sets", []))

        self.cards = []
        self.by_id = {}
        loaded_sets = 0
        self.source = str(website_root)
        for entry in wanted_sets:
            set_id = entry["id"]
            set_path = sets_dir / f"{set_id}.json"
            if not set_path.exists():
                print(f"WARN missing set data: {set_path}", file=sys.stderr)
                continue
            with open(set_path, encoding="utf-8") as handle:
                data = json.load(handle)
            info = data.get("setInfo") or {}
            release_date = info.get("releaseDate") or ""
            printed_total = info.get("printedTotal") or info.get("total") or 0
            set_name = info.get("name") or entry.get("name") or set_id
            era_name = entry.get("name") or ""
            if era_name == set_name:
                era_name = ""
            for card in data.get("cards", []):
                number = str(card.get("number") or "")
                name = card.get("name") or ""
                record = {
                    "id": card.get("id") or f"{set_id}-{number}",
                    "name": name,
                    "number": number,
                    "setId": set_id,
                    "setName": set_name,
                    "printedTotal": printed_total,
                    "releaseDate": release_date,
                    "image": (card.get("images") or {}).get("small"),
                    "price": min_price(card),
                    "eraName": era_name,
                }
                self.cards.append(record)
                self.by_id[record["id"]] = record
            loaded_sets += 1
        self._index()
        print(f"Catalog: {len(self.cards)} cards across {loaded_sets} vintage sets", flush=True)

    @classmethod
    def load(cls, website_root: Path, era_ids, snapshot: Path):
        """Read the website checkout; fall back to the last snapshot when it is
        unreadable (macOS privacy blocks ~/Documents for some terminals)."""
        try:
            catalog = cls(website_root, era_ids)
            if catalog.cards:
                catalog.save_snapshot(snapshot)
                return catalog
        except OSError as error:
            print(f"WARN cannot read {website_root}: {error}", file=sys.stderr)
        if not snapshot.exists():
            raise SystemExit(f"No card catalog: {website_root} unreadable and no {snapshot}")
        catalog = cls.__new__(cls)
        catalog.cards = json.loads(snapshot.read_text(encoding="utf-8"))
        catalog.by_id = {card["id"]: card for card in catalog.cards}
        catalog.source = str(snapshot)
        catalog._index()
        print(f"Catalog: {len(catalog.cards)} cards from snapshot {snapshot}", flush=True)
        return catalog

    def save_snapshot(self, path: Path):
        fields = ("id", "name", "number", "setId", "setName", "eraName", "printedTotal",
                  "releaseDate", "image", "price")
        slim = [{k: card.get(k) for k in fields} for card in self.cards]
        atomic_write(path, json.dumps(slim, separators=(",", ":")).encode("utf-8"))

    def _index(self):
        compact_names = set()
        for card in self.cards:
            card["key"] = owned_key(card["setId"], card["number"])
            name = normalize_text(card["name"])
            compact = re.sub(r"[^a-z0-9]", "", name)  # "Ho-oh" -> "hooh", "Mr. Mime" -> "mrmime"
            compact_names.add(compact)
            haystack = " ".join(normalize_text(card.get(k)) for k in ("name", "setName", "eraName"))
            card["_words"] = set(re.findall(r"[a-z0-9]+", haystack)) | {compact}
            card["_set_words"] = set(re.findall(r"[a-z0-9]+", normalize_text(card["setName"])))
            card["_name_words"] = re.findall(r"[a-z0-9]+", name)
        self.vocabulary = sorted({w for card in self.cards for w in card["_words"] if not w.isdigit()})
        self._vocab_set = set(self.vocabulary)
        self._compact_names = compact_names

    @staticmethod
    def _word_match(token: str, words) -> bool:
        """Whole word, or a word prefix for 3+ letters ("char" -> Charizard,
        Charmander) so the keypad works with partial names."""
        if len(token) < 3:
            return token in words
        return any(word.startswith(token) for word in words)

    def _known(self, token: str) -> bool:
        return self._word_match(token, self._vocab_set)

    def join_split_words(self, tokens):
        joined = []
        i = 0
        while i < len(tokens):
            if i + 1 < len(tokens):
                pair = tokens[i] + tokens[i + 1]
                both_known = tokens[i] in self._vocab_set and tokens[i + 1] in self._vocab_set
                if pair in self._compact_names or (pair in self._vocab_set and not both_known):
                    joined.append(pair)
                    i += 2
                    continue
            joined.append(tokens[i])
            i += 1
        return joined

    def resolve_tokens(self, tokens):
        """Map Whisper's words onto catalog words: singularize ("charizards"),
        fix near-misses ("charzard"), and drop words that match nothing
        ("show", "me", "thank you")."""
        resolved = []
        for token in tokens:
            if token in STOP_WORDS:
                continue
            if self._known(token):
                resolved.append(token)
            elif token.endswith("s") and self._known(token[:-1]):
                resolved.append(token[:-1])
            elif len(token) >= 4:
                close = difflib.get_close_matches(token, self.vocabulary, n=1, cutoff=0.8)
                if close:
                    resolved.append(close[0])
        return resolved

    def search(self, query: str):
        text_tokens, numeric_tokens = tokenize_query(query, self.join_split_words)
        text_tokens = self.resolve_tokens(text_tokens)
        if not text_tokens and not numeric_tokens:
            return []

        results = []
        for card in self.cards:
            words = card["_words"]
            if text_tokens and not all(self._word_match(token, words) for token in text_tokens):
                continue

            number_values = number_search_values(card)
            matched = sum(1 for token in numeric_tokens if token in number_values)
            if numeric_tokens and not text_tokens and matched == 0:
                continue  # pure-number searches stay strict
            if numeric_tokens and matched == len(numeric_tokens):
                score = 3
            elif matched > 0:
                score = 2
            else:
                score = 1

            # Spoken set intent ("charizard base") should outrank release order
            set_intent = 1 if any(self._word_match(t, card["_set_words"]) for t in text_tokens) else 0
            # Plain "Charizard" before "Dark Charizard" / "Blaine's Charizard"
            extra_name_words = len([w for w in card["_name_words"] if w not in text_tokens])

            results.append((-score, -set_intent, extra_name_words, card["releaseDate"] or "9999",
                            sort_number(card), card))

        results.sort(key=lambda item: item[:5])
        return [item[5] for item in results[:MAX_SENT_MATCHES]]


def slim_match(card, owned_keys) -> dict:
    """Only the fields the firmware parses; keeps the serial line short."""
    return {
        "id": card["id"],
        "name": card["name"],
        "number": card["number"],
        "set": card["setName"],
        "total": card["printedTotal"],
        "price": card["price"],
        "owned": card["key"] in owned_keys,
    }


def number_search_values(card) -> set:
    values = set()
    raw = card["number"].lower().strip()
    if raw:
        values.add(raw)
        for part in re.findall(r"\d+", raw):
            values.add(part.lstrip("0") or "0")
    total = card.get("printedTotal")
    if total:
        values.add(str(total))
    return values


def sort_number(card):
    match = re.match(r"(\d+)", card["number"])
    return int(match.group(1)) if match else 9999


def variant_price(price_data):
    listed = [v for v in (price_data.get("low"), price_data.get("directLow"))
              if isinstance(v, (int, float)) and v > 0]
    if listed:
        return min(listed)
    fallback = [v for v in (price_data.get("market"), price_data.get("mid"))
                if isinstance(v, (int, float)) and v > 0]
    return min(fallback) if fallback else None


def min_price(card) -> float:
    prices = ((card.get("tcgplayer") or {}).get("prices")) or {}
    available = [p for p in (variant_price(v) for v in prices.values()) if p is not None]
    return round(min(available), 2) if available else 0.0


def owned_key(set_id, number) -> str:
    return f"{set_id}|{normalize_number(number)}"


def atomic_write(path: Path, data: bytes):
    """Write via a unique temp file + rename: concurrent writers of the same
    path (image prewarm vs. a live request) can never collide or leave a
    half-written file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Owned collection (live Pokévault sync)
# ---------------------------------------------------------------------------

def fetch_owned_from_pokvault(base_url: str, username: str, slug: str) -> list:
    """Fetch your inventory through the same public endpoint the website's
    shared-collection pages use. Raises on any failure."""
    url = f"{base_url.rstrip('/')}/api/public/u/{username}/{slug}/inventory"
    request = urllib.request.Request(url, headers={"User-Agent": "esp32-pokedex/1.0"})
    payload = json.loads(urllib.request.urlopen(request, timeout=20).read())
    keys = []
    for entry in (payload.get("cards") or {}).values():
        total = 0
        inventory = entry.get("inventory") or {}
        for variant in inventory.values():
            for bucket in ("raw", "graded"):
                for quantity in (variant.get(bucket) or {}).values():
                    if isinstance(quantity, (int, float)) and quantity > 0:
                        total += quantity
        if total > 0:
            keys.append(owned_key(entry.get("setId"), entry.get("cardNumber")))
    return keys


class OwnedStore:
    """Your Pokévault inventory, refreshed live every few minutes.

    Primary source: pokvault.com public collection API (same data the website
    shows). Fallbacks: wrangler D1 query, then the SQL backup snapshot.
    """

    def __init__(self, website_root: Path, path: Path, vault_url: str,
                 vault_user: str, vault_slug: str, refresh_interval: int = 300):
        self.website_root = website_root
        self.path = path
        self.vault_url = vault_url
        self.vault_user = vault_user
        self.vault_slug = vault_slug
        self.refresh_interval = refresh_interval
        self._lock = threading.Lock()
        self._keys: set = set()

        if path.exists():
            try:
                self._keys = set(json.loads(path.read_text(encoding="utf-8")))
                print(f"Loaded {len(self._keys)} owned keys from cache")
            except Exception:
                pass
        if not self._keys:
            backup = parse_owned_from_sql_backup(website_root)
            if backup:
                self._keys = set(backup)
                try:
                    atomic_write(path, json.dumps(sorted(backup)).encode("utf-8"))
                    print(f"Cached {len(backup)} owned card keys -> {path}")
                except Exception:
                    pass
        if not self._keys:
            print("WARN no owned-card source yet; cards show as missing until first sync",
                  file=sys.stderr)

        threading.Thread(target=self._refresh_loop, daemon=True).start()

    def _refresh_once(self):
        try:
            return fetch_owned_from_pokvault(self.vault_url, self.vault_user, self.vault_slug), "pokevault.com"
        except Exception:
            pass
        keys = refresh_owned_from_wrangler(self.website_root)
        return (keys, "live D1") if keys is not None else (None, None)

    def _refresh_loop(self):
        while True:
            try:
                keys, source = self._refresh_once()
            except Exception as error:  # never let the sync thread die
                print(f"WARN owned-card sync failed: {error}", file=sys.stderr)
                keys, source = None, None
            if keys is not None:
                with self._lock:
                    self._keys = set(keys)
                try:
                    atomic_write(self.path, json.dumps(sorted(keys)).encode("utf-8"))
                except Exception:
                    pass
                print(f"Live PokeVault sync via {source}: {len(keys)} owned cards", flush=True)
            time.sleep(self.refresh_interval)

    def snapshot(self) -> set:
        with self._lock:
            return set(self._keys)


# ---------------------------------------------------------------------------
# Owned collection
# ---------------------------------------------------------------------------

def refresh_owned_from_wrangler(website_root: Path) -> list | None:
    """Query the live D1 database through wrangler; returns keys or None."""
    import subprocess
    command = [
        "npx", "wrangler", "d1", "execute", "pokvault-db", "--remote", "--json",
        "--command", "SELECT set_id, card_number FROM inventory",
    ]
    try:
        result = subprocess.run(
            command, cwd=website_root, capture_output=True, text=True, timeout=180,
        )
    except Exception as error:
        print(f"WARN wrangler query failed: {error}", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(f"WARN wrangler query failed: {result.stderr.strip()[-300:]}", file=sys.stderr)
        return None

    try:
        payload = json.loads(result.stdout)
        rows = payload[0]["results"] if isinstance(payload, list) else payload["results"]
        keys = [owned_key(row["set_id"], row["card_number"]) for row in rows]
        print(f"Fetched {len(keys)} inventory rows from live D1")
        return keys
    except Exception as error:
        print(f"WARN could not parse wrangler output: {error}", file=sys.stderr)
        return None


def parse_owned_from_sql_backup(website_root: Path) -> list | None:
    backup = website_root / "pokvault-db-backup.sql"
    try:
        if not backup.exists():
            return None
    except OSError:
        return None
    # Row layout: VALUES('id','user_id','set_id','card_number',...)
    row_pattern = re.compile(r"VALUES\('(?:[^']*)','(?:[^']*)','([^']*)','([^']*)'")
    keys = []
    with open(backup, encoding="utf-8") as handle:
        for line in handle:
            if 'INSERT INTO "inventory"' not in line:
                continue
            for set_id, number in row_pattern.findall(line):
                keys.append(owned_key(set_id, number))
    if keys:
        print(f"Parsed {len(keys)} inventory rows from SQL backup")
    return keys or None


# ---------------------------------------------------------------------------
# Card images
# ---------------------------------------------------------------------------

class ImageServer:
    def __init__(self, catalog: Catalog, cache_dir: Path):
        self.catalog = catalog
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def rgb565_bytes(self, card_id: str) -> bytes:
        """Artwork for a card as raw RGB565; a placeholder when unavailable."""
        cache_path = self.cache_dir / f"{card_id}_{IMG_WIDTH}x{IMG_HEIGHT}.raw"
        if cache_path.exists() and cache_path.stat().st_size == IMG_WIDTH * IMG_HEIGHT * 2:
            return cache_path.read_bytes()

        png_path = self.cache_dir / f"{card_id}.png"
        card = self.catalog.by_id.get(card_id)
        url = (card or {}).get("image")
        if not url and card:
            url = (f"https://images.pokemontcg.io/{card['setId']}/"
                   f"{urllib.parse.quote(card['number'])}.png")
        if url:
            try:
                if not png_path.exists() or png_path.stat().st_size == 0:
                    request = urllib.request.Request(url, headers={"User-Agent": "esp32-pokedex/1.0"})
                    atomic_write(png_path, urllib.request.urlopen(request, timeout=10).read())
                image = Image.open(png_path).convert("RGB").resize((IMG_WIDTH, IMG_HEIGHT), Image.LANCZOS)
            except Exception as error:
                print(f"WARN image fetch failed for {card_id}: {error}", file=sys.stderr)
                image = None
        else:
            image = None
        if image is None:
            # Not cached to disk: a transient network failure should retry later
            return rgb565(placeholder_image())

        data = rgb565(image)
        atomic_write(cache_path, data)
        return data


def rgb565(image: Image.Image) -> bytes:
    pixels = np.asarray(image, dtype=np.uint32)
    encoded = ((pixels[:, :, 0] >> 3) << 11) | ((pixels[:, :, 1] >> 2) << 5) | (pixels[:, :, 2] >> 3)
    return encoded.astype("<u2").tobytes()


class ActivityGate:
    """Lets background work yield while the user is actively searching."""

    def __init__(self):
        self._busy_until = 0.0
        self._lock = threading.Lock()

    def mark_busy(self, seconds: float = 60):
        with self._lock:
            self._busy_until = time.time() + seconds

    def idle(self) -> bool:
        with self._lock:
            return time.time() >= self._busy_until


ACTIVITY = ActivityGate()


def prewarm_images(image_server: ImageServer, label: str = ""):
    """Download + convert the whole vintage catalog once, in the background,
    so lookups never wait on the network again. Runs slowly and yields
    whenever a lookup is in progress."""

    def _run():
        cache = image_server.cache_dir
        cards = [card for card in image_server.catalog.cards
                 if not (cache / f"{card['id']}_{IMG_WIDTH}x{IMG_HEIGHT}.raw").exists()]
        if not cards:
            return
        print(f"Warming image cache: {len(cards)} cards missing...", flush=True)

        def _work(card):
            while not ACTIVITY.idle():
                time.sleep(1.5)
            try:
                image_server.rgb565_bytes(card["id"])
                return True
            except Exception:
                return False

        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(_work, cards))
        failed = results.count(False)
        print(f"Image cache warm: {len(cards) - failed} ok, {failed} failed {label}".strip(),
              flush=True)

    threading.Thread(target=_run, daemon=True).start()


def placeholder_image() -> Image.Image:
    image = Image.new("RGB", (IMG_WIDTH, IMG_HEIGHT), (23, 26, 45))
    draw = ImageDraw.Draw(image)
    draw.rectangle([4, 4, IMG_WIDTH - 5, IMG_HEIGHT - 5], outline=(111, 91, 211), width=2)
    draw.text((IMG_WIDTH // 2 - 24, IMG_HEIGHT // 2 - 16), "NO IMAGE", fill=(139, 147, 181))
    return image


# ---------------------------------------------------------------------------
# psapop live prices (https://pok.darksweep.com, Andrew's PSA/TCGplayer backend)
# ---------------------------------------------------------------------------

class PriceEnricher:
    """Refreshes card prices from the psapop API with caching and fallback.

    The static catalog prices (fetched Jan 2026) stay as the offline source of
    truth; this only overrides them when the API answers within the timeout.
    """

    def __init__(self, base_url: str, cache_path: Path, enabled: bool = True,
                 ttl_seconds: int = 7 * 86400):
        self.base_url = base_url.rstrip("/")
        self.cache_path = cache_path
        self.enabled = enabled
        self.ttl = ttl_seconds
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="psapop")
        self.mem: dict[str, tuple[float, float]] = {}
        if cache_path.exists():
            try:
                self.mem = {k: (v[0], v[1]) for k, v in json.loads(
                    cache_path.read_text(encoding="utf-8")).items()}
            except Exception:
                self.mem = {}

    def _cache_get(self, key: str):
        with self._lock:
            hit = self.mem.get(key)
        if hit and time.time() - hit[0] < self.ttl:
            return hit[1]
        return None

    def _persist(self):
        with self._lock:
            trimmed = {k: v for k, v in self.mem.items()
                       if time.time() - v[0] < self.ttl}
        try:
            atomic_write(self.cache_path, json.dumps(trimmed).encode("utf-8"))
        except Exception:
            pass

    def fetch(self, set_id: str, number: str) -> float | None:
        if not self.enabled:
            return None
        key = f"{set_id}|{normalize_number(number)}"
        cached = self._cache_get(key)
        if cached is not None:
            return cached
        url = (f"{self.base_url}/tcg/{set_id}/card/{urllib.parse.quote(number)}/prices")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "esp32-pokedex/1.0"})
            payload = json.loads(urllib.request.urlopen(request, timeout=3).read())
            candidates = []
            for entry in payload.get("prices", []):
                for field in ("low_price", "direct_low_price"):
                    value = entry.get(field)
                    if isinstance(value, (int, float)) and value > 0:
                        candidates.append(value)
                if not candidates:
                    for field in ("market_price", "mid_price"):
                        value = entry.get(field)
                        if isinstance(value, (int, float)) and value > 0:
                            candidates.append(value)
            price = round(min(candidates), 2) if candidates else None
        except Exception:
            return None  # unreachable/slow: keep static price silently
        if price is not None:
            with self._lock:
                self.mem[key] = (time.time(), price)
        return price


def enrich_matches(matches, enricher: PriceEnricher | None, budget_seconds: float = 1.5):
    """Refresh prices concurrently within a hard time budget. Cached prices
    apply instantly; slow lookups keep running in the background and land in
    the cache for next time instead of holding up the answer."""
    if not enricher or not enricher.enabled or not matches:
        return matches

    def work(match):
        set_id = match["id"].rsplit("-", 1)[0]
        return enricher.fetch(set_id, match["number"])

    deadline = time.time() + budget_seconds
    futures = [(match, enricher._pool.submit(work, match)) for match in matches]
    refreshed = 0
    for match, future in futures:
        try:
            live_price = future.result(timeout=max(0.0, deadline - time.time()))
        except Exception:
            continue
        if live_price:
            match["price"] = live_price
            refreshed += 1
    if refreshed:
        print(f"psapop: refreshed {refreshed} prices", flush=True)
    enricher._pool.submit(enricher._persist)
    return matches


# ---------------------------------------------------------------------------
# Serial protocol
# ---------------------------------------------------------------------------

def find_board_port() -> str | None:
    for port in list_ports.comports():
        if port.vid == ESPRESSIF_VID and port.pid == ESPRESSIF_PID:
            return port.device
    return None


class Board:
    """Line-oriented link to the firmware.

    readline() only ever returns complete lines: pyserial's own readline()
    hands back a partial line when its timeout expires mid-line, which used to
    corrupt audio uploads."""

    def __init__(self, device):
        self.device = device
        self._buffer = bytearray()

    def readline(self) -> str | None:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                raw = bytes(self._buffer[:newline])
                del self._buffer[:newline + 1]
                return raw.decode("utf-8", errors="replace").strip()
            chunk = self.device.read(max(1, self.device.in_waiting))
            if not chunk:
                return None  # timeout: nothing complete yet
            self._buffer.extend(chunk)

    def send(self, line: str):
        self.device.write((line + "\n").encode("ascii"))

    def send_many(self, lines):
        self.device.write("".join(line + "\n" for line in lines).encode("ascii"))


def b64_argue(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def write_wav(path: Path, pcm: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)


class VoiceRecognizer:
    """Recognizes which card a recording names by scoring every catalog card
    name against the audio, rather than transcribing freely.

    Free transcription snaps unusual names onto common words ("Gengar" ->
    "Jungle", "Flareon" -> "Florian"); asking Whisper how likely each known
    name is fixes that. One audio encoding serves three decoder passes:
      1. a plain transcript, to find leading filler ("show me the") and silence;
      2. every name scored right after that filler: one decoder step ranks all
         names by their first token, then the shortlist is scored in full,
         including the chance that the name ends there ("Mew" vs "Mewtwo");
      3. the words after the chosen name ("base", "two"), decoded greedily."""

    SHORTLIST = 48
    TOKEN_BONUS = 0.5    # per name token: long names are not penalized for length
    MAX_TOKENS = 32

    def __init__(self, repo: str, names):
        self.repo = repo
        self.names = sorted(set(names))
        self._ready = threading.Event()
        self._error = None
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            self.model = load_models.load_model(self.repo, dtype=mx.float16)
            self.tok = get_tokenizer(self.model.is_multilingual,
                                     num_languages=self.model.num_languages,
                                     language="en", task="transcribe")
            self.sot = list(self.tok.sot_sequence_including_notimestamps)
            self.seqs = [self.tok.encode(" " + name) for name in self.names]
            self.first = np.array([seq[0] for seq in self.seqs])
            # Tokens that may follow a complete name: a new word, punctuation,
            # a plural "s", or the end of the utterance
            boundary = np.zeros(self.model.dims.n_vocab, dtype=bool)
            for token in range(self.tok.eot):
                text = self.tok.decode([token])
                boundary[token] = text[:1] == " " or not text[:1].isalnum() or text == "s"
            boundary[self.tok.eot] = True
            self.boundary = mx.array(boundary)
            self._recognize(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))  # compile kernels
            print(f"Whisper {self.repo.split('/')[-1]} ready: {len(self.names)} card names",
                  flush=True)
        except Exception as error:
            self._error = error
            print(f"WARN whisper load failed: {error}", file=sys.stderr)
        finally:
            self._ready.set()

    def _greedy(self, prefix, features):
        """Decode from `prefix` until end of text; returns the new tokens."""
        tokens = mx.array([prefix])
        cache = None
        out = []
        for _ in range(self.MAX_TOKENS):
            logits, cache, _ = self.model.decoder(tokens, features, kv_cache=cache)
            logits = logits[0, -1]
            logits[self.tok.eot + 1:] = -mx.inf  # no timestamps or special tokens
            token = int(mx.argmax(logits).item())
            if token == self.tok.eot:
                break
            out.append(token)
            tokens = mx.array([[token]])
        return out

    def _rank_names(self, prefix, features):
        """[(name, score)] for the shortlist, best first."""
        logits = self.model.logits(mx.array([prefix]), features)[0, -1].astype(mx.float32)
        first_lp = np.array(logits - mx.logsumexp(logits))[self.first]
        keep = np.argsort(-first_lp)[:self.SHORTLIST]

        seqs = [self.seqs[i] for i in keep]
        lens = np.array([len(seq) for seq in seqs])
        tokens = np.full((len(seqs), len(prefix) + lens.max() + 1), self.tok.eot, dtype=np.int32)
        for row, seq in enumerate(seqs):
            tokens[row, :len(prefix)] = prefix
            tokens[row, len(prefix):len(prefix) + len(seq)] = seq
        tokens = mx.array(tokens)
        batch = len(seqs)
        feats = mx.broadcast_to(features, (batch, *features.shape[1:]))
        logits = self.model.logits(tokens[:, :-1], feats).astype(mx.float32)
        logp = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        token_lp = mx.take_along_axis(logp, tokens[:, 1:, None], axis=-1)[..., 0]
        start = len(prefix) - 1
        pos = mx.arange(tokens.shape[1] - 1)[None, :]
        in_name = (pos >= start) & (pos < start + mx.array(lens)[:, None])
        name_lp = mx.sum(mx.where(in_name, token_lp, 0.0), axis=1)
        end_logits = logp[mx.arange(batch), mx.array(start + lens)]
        end_lp = mx.logsumexp(mx.where(self.boundary[None, :], end_logits, -mx.inf), axis=-1)
        scores = np.array(name_lp + end_lp) + self.TOKEN_BONUS * lens
        order = np.argsort(-scores)
        return [(self.names[keep[i]], float(scores[i])) for i in order]

    _lock = threading.Lock()

    def recognize(self, audio: np.ndarray):
        """Returns (heard, name, rest): the plain transcript, the card name it
        most likely says, and the words spoken after it. name is None when
        nothing was said."""
        self._ready.wait()
        if self._error:
            raise RuntimeError(f"Whisper unavailable: {self._error}")
        with self._lock:
            return self._recognize(audio)

    def _recognize(self, audio):
        mel = log_mel_spectrogram(audio, n_mels=self.model.dims.n_mels, padding=N_SAMPLES)
        mel = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
        features = self.model.embed_audio(mel[None])

        heard = self.tok.decode(self._greedy(self.sot, features)).strip()
        # Whisper tags non-speech as "(water running)" or "[Music]"
        spoken = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", heard).split()
        words = [re.sub(r"[^a-z0-9]", "", normalize_text(w)) for w in spoken]
        if all(not w or w in STOP_WORDS for w in words):
            return heard, None, ""  # silence, noise, or a stray "you" / "thank you"
        lead = 0
        while lead < len(words) - 1 and words[lead] in LEAD_WORDS:
            lead += 1
        prefix = self.sot + (self.tok.encode(" " + " ".join(spoken[:lead])) if lead else [])

        name = self._rank_names(prefix, features)[0][0]
        rest = self.tok.decode(self._greedy(prefix + self.tok.encode(" " + name), features))
        rest = re.sub(r"^s\b", "", rest)  # plural: "Charizards"
        return heard, name, " ".join(re.findall(r"[\w'-]+", rest))


def stream_image(board: Board, image_server: ImageServer, card_id: str):
    try:
        data = image_server.rgb565_bytes(card_id)
    except Exception as error:
        print(f"WARN image for {card_id} failed: {error}", file=sys.stderr)
        board.send(f"@IMGERR {card_id}")
        return
    start = time.time()
    chunk_size = 3600  # 4800 base64 chars per line; firmware line buffer is 5120
    lines = [f"@IMG {card_id} {IMG_WIDTH} {IMG_HEIGHT}"]
    lines += ["@DATA " + base64.b64encode(data[offset:offset + chunk_size]).decode("ascii")
              for offset in range(0, len(data), chunk_size)]
    lines.append(f"@IMGEND {card_id}")
    board.send_many(lines)
    print(f"Sent {card_id} ({len(data)} bytes) in {time.time() - start:.2f}s", flush=True)


# ---------------------------------------------------------------------------
# Network link (optional): the board over Wi-Fi instead of USB
# ---------------------------------------------------------------------------

class NetworkLink:
    """A board connected over a WebSocket, shaped like the serial port Board
    reads from: text frames in, text frames out, same line protocol."""

    def __init__(self, websocket, loop, peer: str):
        self.websocket = websocket
        self.loop = loop
        self.peer = peer
        self._buffer = bytearray()
        self._ready = threading.Condition()
        self._closed = False

    # -- fed from the asyncio side --
    def feed(self, data: bytes):
        with self._ready:
            self._buffer.extend(data)
            self._ready.notify_all()

    def close(self):
        with self._ready:
            self._closed = True
            self._ready.notify_all()

    # -- what Board expects from a serial port --
    @property
    def in_waiting(self) -> int:
        with self._ready:
            return len(self._buffer)

    def read(self, size: int = 1) -> bytes:
        with self._ready:
            if not self._buffer and not self._closed:
                self._ready.wait(0.25)
            if not self._buffer and self._closed:
                raise ConnectionError(f"board {self.peer} disconnected")
            chunk = bytes(self._buffer[:size])
            del self._buffer[:size]
            return chunk

    def write(self, data: bytes):
        if self._closed:
            raise ConnectionError(f"board {self.peer} disconnected")
        future = asyncio.run_coroutine_threadsafe(self.websocket.send(data.decode("ascii")), self.loop)
        future.result(timeout=20)
        return len(data)


def serve_network(host: str, port: int, token: str, services):
    """Accept boards at ws://host:port/?token=... (put Tailscale Funnel or a
    reverse proxy in front for TLS). Runs its own event loop thread."""
    from websockets.asyncio.server import serve

    async def handler(websocket):
        peer = "%s:%s" % websocket.remote_address[:2] if websocket.remote_address else "?"
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(websocket.request.path).query)
        offered = (query.get("token") or [""])[0] or websocket.request.headers.get("X-PokeDex-Token", "")
        if not hmac.compare_digest(offered, token):
            print(f"WARN rejected network board {peer}: bad token", file=sys.stderr)
            await websocket.close(4001, "bad token")
            return
        loop = asyncio.get_running_loop()
        link = NetworkLink(websocket, loop, peer)
        print(f"PokeDex board connected over the network ({peer})", flush=True)

        def session():
            try:
                serve_session(Board(link), *services)
            except (ConnectionError, OSError) as error:
                print(f"Network board gone: {error}", flush=True)

        worker = threading.Thread(target=session, daemon=True)
        worker.start()
        try:
            async for message in websocket:
                link.feed(message.encode() if isinstance(message, str) else message)
        except Exception as error:  # a dropped cellular link is routine
            print(f"WARN network link dropped ({error})", file=sys.stderr)
        finally:
            link.close()

    async def main():
        async with serve(handler, host, port, max_size=2 ** 22, ping_interval=15, ping_timeout=20):
            print(f"Listening for network boards on ws://{host}:{port}/", flush=True)
            await asyncio.Future()

    threading.Thread(target=lambda: asyncio.run(main()), daemon=True, name="network").start()


def load_token(args) -> str:
    token = args.token or os.environ.get("POKEDEX_TOKEN", "")
    if not token and args.token_file and args.token_file.expanduser().exists():
        token = args.token_file.expanduser().read_text().strip()
    if len(token) < 16:
        raise SystemExit("--listen needs a shared token of 16+ characters "
                         "(--token, POKEDEX_TOKEN, or --token-file)")
    return token


def run(port_arg: str | None, args, website_root: Path):
    owned_store = OwnedStore(website_root, args.owned, args.vault_url,
                             args.vault_user, args.vault_slug)
    catalog = Catalog.load(website_root, args.eras.split(","), args.catalog_snapshot)
    image_server = ImageServer(catalog, args.cache)
    enricher = PriceEnricher(args.psapop, args.price_cache, enabled=not args.no_psapop)
    recognizer = None
    if mlx_whisper is None:
        print("WARN mlx_whisper not installed: voice lookups disabled, typing still works",
              file=sys.stderr)
    else:
        recognizer = VoiceRecognizer(args.model, (card["name"] for card in catalog.cards))
    if not args.no_prewarm_images:
        prewarm_images(image_server)
    if args.listen:
        host, _, listen_port = args.listen.rpartition(":")
        serve_network(host or "127.0.0.1", int(listen_port), load_token(args),
                      (owned_store, catalog, image_server, enricher, recognizer, args))
    if args.no_serial:
        threading.Event().wait()  # network boards only (e.g. the Mac mini)

    waiting_logged = False
    while True:
        # Re-detect every time: the board re-enumerates (and may get a new
        # /dev/cu.usbmodem name) whenever it resets
        port = port_arg or find_board_port()
        if not port:
            if not waiting_logged:
                print("Waiting for the board to be plugged in...", flush=True)
                waiting_logged = True
            time.sleep(1.0)
            continue
        waiting_logged = False
        try:
            serve_board(port, owned_store, catalog, image_server, enricher, recognizer, args)
        except (serial.SerialException, OSError) as error:
            print(f"WARN serial dropped ({error}); reconnecting...", file=sys.stderr)
            time.sleep(1.0)


def serve_board(port: str, owned_store, catalog, image_server, enricher, recognizer, args):
    device = serial.Serial()
    device.port = port
    device.baudrate = 115200
    device.timeout = 0.25
    device.write_timeout = 10
    device.dtr = False
    device.rts = False
    device.open()
    board = Board(device)
    print(f"PokeDex bridge using {port}", flush=True)
    try:
        serve_session(board, owned_store, catalog, image_server, enricher, recognizer, args)
    finally:
        device.close()


def serve_session(board: "Board", owned_store, catalog, image_server, enricher, recognizer, args):
    """One connected board, over USB serial or the network: the same protocol
    either way. Returns or raises when the link drops."""
    expected = 0
    audio = bytearray()
    board.send(f"@READY {PROTOCOL_VERSION}")
    while True:
        line = board.readline()
        if line is None:
            continue
        try:
            if line.startswith("@DATA "):
                if expected:
                    audio.extend(base64.b64decode(line[6:]))
            elif line.startswith("@VOICE "):
                expected = int(line.split(maxsplit=1)[1])
                audio.clear()
                ACTIVITY.mark_busy(60)
            elif line == "@END":
                if not expected:
                    continue
                pcm, wanted = bytes(audio), expected
                expected = 0
                audio.clear()
                if len(pcm) != wanted:
                    message = f"Audio incomplete: {len(pcm)}/{wanted} bytes"
                    print(f"WARN {message}", file=sys.stderr)
                    board.send(f"@ERROR {b64_argue(message)}")
                else:
                    handle_audio(board, pcm, catalog, owned_store, enricher, recognizer, args)
            elif line.startswith("@GETIMG "):
                stream_image(board, image_server, line[8:].strip())
            elif line.startswith("@QUERY "):
                typed = base64.b64decode(line[7:]).decode("utf-8").strip()
                print(f"Typed query: \"{typed}\"", flush=True)
                ACTIVITY.mark_busy(60)
                board.send(f"@TEXT {b64_argue(typed)}")
                lookup_and_reply(board, typed, catalog, owned_store, enricher)
            elif line.startswith("@HELLO"):
                version = line.split()[1] if len(line.split()) > 1 else "1"
                if version != str(PROTOCOL_VERSION):
                    print(f"WARN board speaks protocol {version}, bridge {PROTOCOL_VERSION}: "
                          "reflash the firmware", file=sys.stderr)
                print("Board booted; handshake sent", flush=True)
                board.send(f"@READY {PROTOCOL_VERSION}")
            elif line[:3] in ("I (", "W (", "E ("):
                print(f"ESP32: {line}", flush=True)
        except (serial.SerialException, OSError):
            raise
        except Exception as error:
            # One bad request must never tear down the whole session
            print(f"WARN failed handling {line[:40]!r}: {error}", file=sys.stderr)
            expected = 0
            audio.clear()
            try:
                board.send(f"@ERROR {b64_argue('Mac error: ' + str(error)[:60])}")
            except Exception:
                pass


def handle_audio(board: Board, pcm: bytes, catalog: Catalog, owned_store: OwnedStore,
                 enricher: PriceEnricher, recognizer: VoiceRecognizer | None, args):
    ACTIVITY.mark_busy(60)
    if args.output:
        write_wav(args.output, pcm)
    if recognizer is None:
        board.send(f"@ERROR {b64_argue('Voice unavailable: install mlx-whisper')}")
        return
    start = time.time()
    try:
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        heard, name, rest = recognizer.recognize(audio)
    except Exception as error:
        message = f"Transcription failed: {error}"
        print(message, file=sys.stderr)
        board.send(f"@ERROR {b64_argue(message[:100])}")
        return
    query = f"{name} {rest}".strip() if name else heard
    print(f"Heard: \"{heard}\" -> \"{query}\" ({len(pcm) / (SAMPLE_RATE * 2):.1f}s audio, "
          f"recognized in {time.time() - start:.2f}s)", flush=True)
    board.send(f"@TEXT {b64_argue(query)}")
    fallback = name if name and rest else None
    lookup_and_reply(board, query, catalog, owned_store, enricher, fallback)


def lookup_and_reply(board: Board, query: str, catalog: Catalog, owned_store: OwnedStore,
                     enricher: PriceEnricher, fallback: str | None = None):
    """`fallback` is searched when `query` finds nothing: the recognized name
    alone, in case the words after it were misheard."""
    start = time.time()
    owned_keys = owned_store.snapshot()
    cards = catalog.search(query) or (catalog.search(fallback) if fallback else [])
    matches = [slim_match(card, owned_keys) for card in cards]
    matches = enrich_matches(matches, enricher)
    send_lookup_result(board, query, matches)
    print(f"Lookup answered in {time.time() - start:.2f}s", flush=True)


def send_lookup_result(board: Board, transcript: str, matches):
    top = ", ".join(f"{m['name']} {m['set']}" for m in matches[:3])
    print(f"Matches: {len(matches)}  [{top}]", flush=True)
    display = transcript.strip().rstrip(".!?")
    display = display.title() if display.islower() else display

    # The firmware line buffer is 5120 bytes: drop matches until it fits
    count = len(matches)
    while True:
        payload = json.dumps({"transcript": display, "matches": matches[:count]},
                             separators=(",", ":"))
        line = f"@RESULT {base64.b64encode(payload.encode()).decode('ascii')}"
        if len(line) < 4900 or count == 0:
            break
        count -= 1
    board.send(line)


def build_parser():
    parser = argparse.ArgumentParser(description="Local PokeDex companion for the ESP32-S3 AMOLED")
    parser.add_argument("--port", help="ESP32 USB serial port; auto-detected by default")
    parser.add_argument("--website", type=Path,
                        default=Path.home() / "Documents" / "git" / "pokemon-website",
                        help="Path to the pokemon-website checkout")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Whisper model repo")
    parser.add_argument("--eras", default="original", help="Comma-separated vintage era ids")
    parser.add_argument("--output", type=Path, default=Path("runtime/latest_recording.wav"),
                        help="Where the last recording is saved for debugging")
    parser.add_argument("--catalog-snapshot", type=Path, default=Path("host/catalog_snapshot.json"),
                        help="Catalog copy used when the website checkout is unreadable")
    parser.add_argument("--cache", type=Path, default=Path("host/image_cache"))
    parser.add_argument("--owned", type=Path, default=Path("host/owned_cards.json"),
                        help="Cache file for your Pokévault inventory keys")
    parser.add_argument("--vault-url", default="https://pokvault.com")
    parser.add_argument("--vault-user", default="r31did", help="Pokévault username")
    parser.add_argument("--vault-slug", default="wotc", help="Shared collection slug to mirror")
    parser.add_argument("--psapop", default="https://pok.darksweep.com",
                        help="Base URL of the psapop price API")
    parser.add_argument("--price-cache", type=Path, default=Path("host/price_cache.json"))
    parser.add_argument("--no-psapop", action="store_true",
                        help="Disable live price refresh from psapop")
    parser.add_argument("--no-prewarm-images", action="store_true",
                        help="Skip background download of the full vintage art cache")
    parser.add_argument("--listen", metavar="HOST:PORT",
                        help="Also accept boards over WebSocket (Wi-Fi build), e.g. 127.0.0.1:8765")
    parser.add_argument("--token", help="Shared secret boards must present (or POKEDEX_TOKEN)")
    parser.add_argument("--token-file", type=Path, default=Path("~/.pokedex-token"),
                        help="File holding the shared secret")
    parser.add_argument("--no-serial", action="store_true",
                        help="Don't look for a USB board (network only)")
    return parser


def main():
    args = build_parser().parse_args()

    run(args.port, args, args.website)


if __name__ == "__main__":
    main()

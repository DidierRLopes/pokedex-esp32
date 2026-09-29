# How PokeDex works

What happens between "Venusaur" leaving your mouth and the card appearing on the board. Venusaur is used as the running example; the exact numbers (catalog size, prices, how many printings) come from the data at the time and change.

```
voice ─▶ board mic ─▶ audio lines ─▶ Mac: spectrogram ─▶ Whisper picks a card name
      ─▶ catalog search ─▶ + owned (Pokévault) + price ─▶ results ─▶ board
      ─▶ asks for the art ─▶ card image ─▶ screen                 (about a second)
```

The board and the Mac talk in one line-based protocol, over the USB cable or over Wi-Fi through a WebSocket. Every step below is the same on either link. The message set is documented at the top of [`host/pokemon_bridge.py`](../host/pokemon_bridge.py).

## 1. On the board: recording

```
 you hold the screen
        │
        ▼
┌──────────────────────── ESP32-S3 board ────────────────────────┐
│  mic ─▶ audio codec ─▶ 16 kHz · 16-bit · mono samples          │
│                                                                │
│  The mic is always listening into a short rolling "pre-roll"   │
│  buffer, so the first syllable survives even if you start      │
│  talking the instant you touch the screen.                     │
│                                                                │
│   [ pre-roll ][........... while you hold ...........]         │
│    └──────────────────── one clip ───────────────────┘         │
│                                                                │
│  let go ─▶ the clip goes out as text lines:                    │
│      @VOICE <bytes>                                            │
│      @DATA  <base64 audio>   (a few KB per line)               │
│      @DATA  ...                                                │
│      @END                                                      │
└────────────────────────────────┬───────────────────────────────┘
                                 │  USB  ── or ──  Wi-Fi (WebSocket)
                                 ▼
```

- **Base64 text lines:** the same text channel also carries the board's logs over USB, and a line can always be resynchronised after noise.
- **The board never waits on the Mac:** it keeps drawing and reading buttons. A 30-second watchdog gives up on a lookup that never comes back, and keeps the previous results on screen.

## 2. On the Mac: from sound to a card name

```
┌──────────────────────── companion (Mac) ───────────────────────┐
│  audio ─▶ log-mel spectrogram (a picture of the sound:         │
│           time × frequency bands)                              │
│                     │                                          │
│                     ▼                                          │
│        Whisper ENCODER, run once ─▶ "audio features"           │
│                     │                                          │
│      ┌──────────────┼────────────────────────┐                 │
│      ▼              ▼                        ▼                 │
│   PASS 1         PASS 2                   PASS 3               │
│   plain          score every              the words AFTER      │
│   transcript     card name                the name             │
│                                                                │
│   "Show me the   all names ─first token─▶ a shortlist,         │
│    Venus sore"   each then scored in full, plus                │
│      │           "does the name end here?"                     │
│      │           (so "Mew" can't win on "Mewtwo")              │
│      │                  │                                      │
│      │           best: "Venusaur" ─────▶ continue decoding:    │
│      │                                   nothing, or           │
│      │                                   "base", "two"         │
│      ▼                                                         │
│   used only to:                                                │
│    • skip filler at the start ("show me the", "um")            │
│    • recognise silence or noise ("(music)", "thank you")       │
│      and return nothing instead of a random card               │
│                                                                │
│   query = "Venusaur" (+ "base" / "two" if you said them)       │
└────────────────────────────────┬───────────────────────────────┘
```

**Why pick a name instead of transcribing.** Whisper on its own writes down what it *thinks* it heard, and unusual names get snapped onto common words: "Gengar" becomes "Jungle", "Flareon" becomes "Florian". Asking it instead *which of the card names best explains this sound* is a much easier question with a closed set of answers. On the voice benchmark (synthetic macOS voices), this took accuracy from 46% to 99%.

**How a name is scored.** For each candidate, Whisper gives the probability of that name's tokens following the audio, plus the probability that the name *ends* there. Pass 1 only looks at each name's first token, so the expensive full scoring runs on a short shortlist, not the whole catalog. Longer names get a small per-token allowance, so short names don't win just for being short. The implementation is `VoiceRecognizer` in [`host/pokemon_bridge.py`](../host/pokemon_bridge.py).

**One encoding, three decodes.** Turning the audio into features is the costly step, so it happens once and all three passes read the same features. The whole recognition takes a fraction of a second on an Apple Silicon Mac.

## 3. On the Mac: from a name to cards, owned and price

```
query "Venusaur"
    │
    ▼
┌─ card catalog (the vintage sets) ────────────────────────────┐
│  every card whose name matches, ranked by:                   │
│   • the card number or set you said ("two", "base")          │
│   • plain "Venusaur" before "Erika's Venusaur"               │
│   • release order                                            │
│  ─▶ up to 10 matches                                         │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ enrich each match ───────────────────────────────────────────┐
│  owned?  ◀── your Pokévault collection (re-synced in the      │
│              background every few minutes)                    │
│  price   ◀── TCGplayer data via psapop: cached, with a short  │
│              time budget, falling back to the catalog price   │
└──────────────┬────────────────────────────────────────────────┘
               ▼
   @TEXT   "Venusaur"                       (the title while it works)
   @RESULT [ {Base #15 ✗ $…}, {Promo #13 ✗ $…}, {Base Set 2 #18 ✓ $…}, … ]
```

- **Typed lookups skip section 2:** the keypad's text goes straight into this search, which tolerates typos, plurals and filler ("show me the charzards" finds Charizard).
- **Prices never hold up the answer:** a slow price lookup keeps running in the background and lands in the cache for next time.

## 4. Back on the board: showing the card

```
@RESULT arrives ─▶ draws 1/9: "#15 Venusaur ✗   Base (102)   $…"
        │
        └─▶ asks for the art:  @GETIMG base1-15
                                    │
     Mac: cached card image ─▶ resized to the board's card area
          ─▶ converted to the screen's raw colour format (RGB565)
          ─▶ base64 lines ─▶ board
                                    │
     the board decodes it straight into a small image cache and
     paints it; it also fetches the NEXT printing ahead of time,
     so PWR shows it instantly
```

- **Pre-converted images:** the Mac sends raw pixels in the screen's own colour format, so the board only copies them, with no decoding.
- **Straight into the cache:** image data is decoded as it arrives, instead of passing through the UI task, so a busy screen can never make the incoming data overflow.

## The two links

```
At the desk:  board ══ USB cable ══ Mac (companion)

On the go:    board ─ Wi-Fi ─▶ iPhone hotspot ─ cellular ─▶ internet
                    ─▶ Tailscale Funnel (HTTPS) ─▶ Mac mini at home (companion)
```

The messages are identical on both. On Wi-Fi they travel inside a secure WebSocket, and the board proves itself with a shared token. The board can't run Tailscale itself; Funnel gives the Mac mini a public HTTPS address the board can reach from any network. Setting both up is in the [README](../README.md).

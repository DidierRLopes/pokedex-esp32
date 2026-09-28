# PokeDex ESP32

A handheld lookup for vintage Pokémon cards. Hold the screen, say a card name ("Charizard", "Blastoise two", "Gengar fossil"), let go, and the board shows the card with its price and whether it's in your collection.

It runs on a [Waveshare ESP32-S3-Touch-AMOLED-1.8](https://www.waveshare.com/esp32-s3-touch-amoled-1.8.htm) plugged into a Mac over USB. The board handles the screen, microphone and buttons. A companion script on the Mac does speech recognition and search locally, with no cloud speech service.

## How it works

```
 ESP32 board  ── USB serial ──  Mac companion (host/pokemon_bridge.py)
 screen, mic, buttons           Whisper (mlx) + card catalog + card art
```

- **Voice**: the board streams the recording to the Mac. Free transcription snaps unusual names onto common words ("Gengar" → "Jungle"), so the companion doesn't trust it for the name. Instead it scores every card name in the catalog against the audio and picks the most likely one, then transcribes only the words after it ("base", "two"). Leading filler ("show me the", "um") is skipped, and silence or noise finds nothing instead of a random card. On synthetic speech this picks the right name 99% of the time, against 46% for transcribe-then-search.
- **Search**: the vintage (WOTC) sets only, up to 10 matches, tolerant of typos, plurals and filler words.
- **Collection and prices**: owned ✓/✗ mirrors a Pokévault collection, refreshed every 5 minutes. Prices come from the psapop API with a 7-day cache, falling back to the catalog's own prices when offline.
- **Art**: downloaded once, converted to the screen's format and cached on the Mac, then streamed to the board on demand.

## Using it

| Action | What happens |
|---|---|
| **Hold the screen** | Listens right away (the previous card clears) |
| **Lift your finger** | Searches; the best match appears within about a second |
| **PWR button** | Next match |
| **BOOT button** | Previous match |
| **Both buttons together** | Keypad mode, for noisy rooms: multi-tap typing, then GO. Tap the results to type again. Both buttons again (or VOICE) goes back to voice |
| **Jerk the board twice** | Screen off / on (any button also wakes it) |

A search that finds nothing returns to the listen screen, and a side button brings back the previous results. If the Mac stops answering, the board gives up after 30 s and keeps what was on screen.

## Setup

### Requirements

- Waveshare ESP32-S3-Touch-AMOLED-1.8 and a USB-C data cable
- A Mac with Apple Silicon (the companion uses Apple's MLX)
- [ESP-IDF v5.5](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/get-started/)
- Python 3.12
- A card catalog: a checkout of `pokemon-website` (see [Card data](#card-data))

### Flash the firmware

```bash
source tools/idf_env.sh            # expects ESP-IDF in ~/esp/esp-idf-v5.5.5; set IDF_PATH to override
idf.py build
idf.py -p /dev/cu.usbmodem* flash  # ls /dev/cu.usbmodem* to find the port
```

Board support and LVGL are fetched by the component manager on the first build.

### Run the companion

```bash
python3.12 -m venv .voice-venv
.voice-venv/bin/pip install -r requirements.txt
.voice-venv/bin/python host/pokemon_bridge.py
```

It finds the board automatically, reconnects when the board resets or is replugged, and downloads the Whisper model (`small.en`, about 500 MB) on first run. Start the board and the companion in either order; the board shows `Companion ready` once they're connected.

Useful options:

| Option | Default | Purpose |
|---|---|---|
| `--website PATH` | `~/Documents/git/pokemon-website` | Card catalog checkout |
| `--vault-user`, `--vault-slug` | `r31did`, `wotc` | Pokévault collection to mirror |
| `--model REPO` | `mlx-community/whisper-small.en-mlx` | Whisper model (`whisper-base-mlx` is faster, less accurate) |
| `--eras` | `original` | Which eras to search |
| `--no-psapop` | off | Skip live prices |
| `--port` | auto | Serial port |

On macOS, the terminal running the companion needs access to the Documents folder (System Settings → Privacy & Security → Files and Folders) to read the catalog. When the catalog can't be read, the companion falls back to `host/catalog_snapshot.json`, which it refreshes on every successful load.

### Card data

The catalog is read from a `pokemon-website` checkout:

- `src/data/eras.json`: eras and their set ids
- `public/data/sets/<setId>.json`: `{"setInfo": {...}, "cards": [...]}`, with cards in the [pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data) format

Any directory with that layout works with `--website`.

## Tests

```bash
.voice-venv/bin/python host/test_bridge.py "Gengar"   # no hardware: a pty plays the board
.voice-venv/bin/python host/test_board.py --voice     # real board (stop the companion first)
```

- `test_bridge.py`: handshake, a spoken lookup (synthesized with `say`), a typed lookup with a typo, and image transfers.
- `test_board.py`: drives the real board through the firmware's `@TEST` hooks. It covers typed lookups, card art, flipping, failed searches, listening clearing the old card, and the 30 s watchdog. `--voice` also plays "Blastoise" and "Gengar" through the Mac speakers for the board's microphone.

Both accept companion options such as `--website`.

`host/capture_screens.py OUT_DIR --name Venusaur` saves pixel-exact PNGs of the board's screens (idle, listening, searching, every result) through the `@TEST SNAPSHOT` hook, plus the exact results the board was sent. The launch video in `video/` is built from these.

## Serial protocol

Version 2, one message per line over the USB-Serial-JTAG port. Board logs share the wire and are ignored by the companion.

| Direction | Message | Meaning |
|---|---|---|
| Board → Mac | `@HELLO 2` | Board booted |
| Mac → Board | `@READY 2` | Companion connected |
| Board → Mac | `@VOICE n` / `@DATA b64`… / `@END` | 16 kHz mono PCM16 recording, with ~640 ms of pre-roll |
| Board → Mac | `@QUERY b64` | Typed card name |
| Mac → Board | `@TEXT b64` | What was recognized |
| Mac → Board | `@RESULT b64json` | Ranked matches (id, name, number, set, price, owned) |
| Board → Mac | `@GETIMG <cardId>` | Request card art |
| Mac → Board | `@IMG <cardId> w h` / `@DATA b64`… / `@IMGEND <cardId>` | Raw RGB565 194×272 frame |
| Mac → Board | `@IMGERR <cardId>` / `@ERROR b64` | No art / lookup failed |
| Mac → Board | `@TEST …` | Test hooks (see `handle_test_command`) |
| Board → Mac | `@SNAP w h stride` / `@SNAPDATA b64`… / `@SNAPEND` | Screen capture (RGB565), answering `@TEST SNAPSHOT` |

## Project layout

```
main/pokemon_lookup.c    firmware: UI, touch and buttons, recording, serial link, image cache
main/assets/             Poké Ball spinner shown while searching
host/pokemon_bridge.py   Mac companion: voice recognition, search, collection, prices, art
host/test_*.py           loopback and on-board tests
tools/idf_env.sh         loads ESP-IDF into the shell
```

## Limitations

- The board needs the Mac: it has no speech model or card data of its own.
- Recognition was measured on synthesized voices; the board's microphone in a loud room will do worse.

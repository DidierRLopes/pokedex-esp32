# PokeDex ESP32

A handheld lookup for vintage Pokémon cards at card shows. Hold the screen, say a card name ("Venusaur", "Charizard base", "Blastoise two"), let go, and the board shows the real card, whether it's already in your Pokévault collection (✓ / ✗), and its live price. The side buttons step through every printing of that Pokémon.

It runs on a [Waveshare ESP32-S3-Touch-AMOLED-1.8](https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.8). The board is the screen, microphone and buttons. A companion program on a Mac does the heavy work: speech recognition, search, collection and prices, card art. A ~20 s demo lives in [`video/`](video/README.md).

## How it works

```
board (screen, mic, buttons) ◀── one line protocol ──▶ companion on a Mac
                                  over USB, or over Wi-Fi     Whisper · catalog · Pokévault · prices · art
```

The board records while you hold the screen and sends the clip to the companion. The companion's Whisper model (Apple MLX, so Apple Silicon) picks which card name best matches the sound instead of transcribing freely, which is what makes odd names like "Gengar" work. It then searches the catalog, adds whether you own each printing and its price, and sends back the results and card art.

**[docs/how-it-works.md](docs/how-it-works.md)** walks through the whole trip step by step, with diagrams: recording, the three Whisper passes, search and enrichment, and how images reach the screen.

Account names, paths and other options: `host/pokemon_bridge.py --help`.

## Two ways to run it

| | At the desk (USB) | On the go (Wi-Fi) |
|---|---|---|
| Board ↔ companion | USB cable to the Mac | Wi-Fi (iPhone hotspot or home) → Tailscale Funnel → Mac mini at home |
| Firmware | default build | Wi-Fi build (still works over USB too) |
| Use it for | development, logs, flashing, tests | card shows: carry only the board and a power bank |

Both can coexist: the Wi-Fi build talks over the network when its WebSocket is up, and over USB otherwise.

## Using the board

| Action | What happens |
|---|---|
| **Hold the screen** | Listens right away; the previous card clears |
| **Let go** | Searches; the card, ✓/✗ and price appear |
| **PWR** (lower side button) | Next printing |
| **BOOT** (upper side button) | Previous printing |
| **Both buttons together** | Keypad mode for noisy rooms (multi-tap, then GO); both again, or VOICE, returns |
| **Jerk the board twice** | Screen off / on (any button also wakes it) |

A failed search returns to the listen screen, and a side button brings back the previous results. If the companion stops answering, the board gives up after 30 s and keeps what was on screen.

## Setup A: at the desk (USB)

Needs a Mac with Apple Silicon, Python 3.12, [ESP-IDF v5.5](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/get-started/) (expected at `~/esp/esp-idf-v5.5.5`; set `IDF_PATH` to override), the board and a USB-C data cable.

```bash
python3.12 -m venv .voice-venv && .voice-venv/bin/pip install -r requirements.txt

source tools/idf_env.sh
idf.py build
idf.py -p /dev/cu.usbmodem* flash            # ls /dev/cu.usbmodem* for the port

.voice-venv/bin/python host/pokemon_bridge.py   # finds the board by itself
```

The board shows `Companion ready` once they're talking. The first run downloads the Whisper model (~460 MB); a lookup then takes well under a second. Start the board and companion in either order: they re-handshake whenever the board resets. Opening the USB port resets the board.

## Setup B: on the go (Mac mini + Tailscale + Wi-Fi)

```
board ─Wi-Fi─▶ iPhone hotspot ─cellular─▶ internet ─▶ Tailscale Funnel (HTTPS) ─▶ Mac mini: companion on 127.0.0.1:8765
```

The Mac mini stays on at home. Tailscale Funnel gives it a public HTTPS address. The board can't run Tailscale itself, so it connects to that address and presents a shared token. The companion only listens on localhost; Funnel provides the address and the TLS certificate.

### 1. Mac mini: the companion as an always-on service

Needs Apple Silicon, Python 3.12, and [Tailscale](https://tailscale.com/download/mac) installed and signed in. No ESP-IDF needed here.

```bash
git clone https://github.com/DidierRLopes/pokedex-esp32.git && cd pokedex-esp32
python3.12 -m venv .voice-venv && .voice-venv/bin/pip install -r requirements.txt
host/macmini/install.sh
tailscale funnel --bg 8765
```

- **`install.sh`** registers a launchd service: it starts at login and restarts if it crashes. It creates the shared token in `~/.pokedex-token` and prints the two lines the board needs (URL and token). Rerunning it is safe; `install.sh uninstall` removes it.
- **Funnel:** the first `tailscale funnel` may ask you to enable Funnel for the tailnet in the Tailscale admin console; follow the link it prints. The address is `https://<mac-mini>.<tailnet>.ts.net/`.
- **Card catalog:** a background service can't show macOS's "allow access to Documents" prompt, so a catalog under `~/Documents` may silently fail to load. Either keep the `pokemon-website` checkout outside `~/Documents` and pass `POKEDEX_ARGS="--website /path/to/pokemon-website" host/macmini/install.sh`, or copy `host/catalog_snapshot.json` from a Mac that has loaded the catalog (the companion falls back to it).
- **Stay on:** System Settings > Energy: prevent automatic sleeping, and start up automatically after a power failure.
- **Logs:** `tail -f ~/Library/Logs/pokedex-companion.log`. Expect `Catalog: … cards`, `Whisper … ready`, `Listening for network boards`, then `board connected over the network` when the board joins.

Check it before touching the board:

```bash
.voice-venv/bin/python host/test_network.py Gengar   # spoken + typed lookup and images over a WebSocket
curl -i https://<mac-mini>.<tailnet>.ts.net/         # from another network: any HTTP reply means Funnel reaches it
```

`test_network.py` starts its own companion on a spare port, so it doesn't disturb the service.

### 2. Build machine: flash the Wi-Fi firmware

On the machine with ESP-IDF and the board on USB:

```bash
cp sdkconfig.defaults.wifi.local.example sdkconfig.defaults.wifi.local   # git-ignored: passwords, URL, token
# fill in the networks, plus the URL and token install.sh printed
tools/build_wifi.sh flash
```

- **Separate build:** the Wi-Fi build lives in `build-wifi/` with its own `sdkconfig.wifi`, regenerated on every run, so the default build is never touched. `tools/build_wifi.sh` without `flash` only builds.
- **Two networks:** the board tries the first network and, if it can't join, alternates with the second. Put home first and the hotspot second: at a show home is absent, so it falls through to the hotspot.
- **Idle screen:** it shows the link state (joining Wi-Fi, connecting, connected), so you can tell where it stops.
- **Back to USB-only:** `idf.py -p /dev/cu.usbmodem* flash`.

### 3. The iPhone hotspot

- **2.4 GHz only:** the ESP32-S3 only speaks 2.4 GHz. Turn on Settings > Personal Hotspot > **Maximize Compatibility**, and **Allow Others to Join**.
- **Network name:** it's the iPhone's name (Settings > General > About > Name) and must match exactly. iPhone names often contain a curly apostrophe (’) that's easy to mistype, so renaming the phone to something plain avoids it.
- **Keep the screen open:** iPhones reliably show the hotspot to a new device only while the Personal Hotspot screen is open, and may turn it off after a while with nothing connected. Keep that screen open while the board joins.

## Testing without the Mac mini (local mode)

Any Mac can stand in for the Mac mini while you test the firmware, with no Tailscale involved:

```bash
.voice-venv/bin/python host/pokemon_bridge.py --listen 0.0.0.0:8765 --no-serial   # token from ~/.pokedex-token
```

- **Board config:** in `sdkconfig.defaults.wifi.local`, set `CONFIG_POKEDEX_SERVER_URL="ws://<the Mac's IP>:8765/"` (plain `ws://`, because there's no TLS on a local network) and the same token, then `tools/build_wifi.sh flash`.
- **Same network:** the Mac and the board must be on the same network. On the iPhone hotspot that means connecting the Mac to the hotspot too; its address changes (typically `172.20.10.x`). The traffic then stays on the phone's Wi-Fi and never uses cellular, so this tests the hotspot link but not the internet path.
- **Firewall:** macOS asks once whether Python may accept incoming connections. Allow it, or `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add <python> --unblockapp <python>`, where `<python>` is the real interpreter behind `.voice-venv` (`readlink -f .voice-venv/bin/python`). A connection that opens but never answers is this firewall.

## When things go wrong

- **The board reboots in a loop, or flashing fails with "No serial data received":** put it in download mode by hand. Unplug USB, hold **BOOT**, plug back in, release, then flash again. Flash the USB-only build (`idf.py flash`) to get back to a known-good state.
- **The Wi-Fi build and memory:** Wi-Fi competes with the display for the chip's internal RAM. The Wi-Fi build moves large buffers, LVGL's heap and two task stacks to PSRAM and draws the display in smaller chunks; [`sdkconfig.defaults.wifi`](sdkconfig.defaults.wifi) says why each setting is there. After any change that adds internal-RAM use, check the boot log line `internal RAM free … after Wi-Fi start`. `Failed to allocate priv TX buffer` errors mean the display has been starved and parts of the screen won't redraw. If Wi-Fi can't start at all, the board says so on screen and keeps working over USB.
- **Connects, then nothing answers:** check the token matches on both sides (the companion logs `bad token`), and that the board's URL is `wss://` for Funnel or `ws://` for local mode.
- **Rotating the token:** edit `~/.pokedex-token` on the Mac mini, rerun `install.sh`, update the board's local file, and reflash.
- **Secrets:** Wi-Fi passwords and the token live only in `sdkconfig.defaults.wifi.local`, the generated `sdkconfig.wifi`, and `~/.pokedex-token`, all git-ignored.

## Tests

| Script | Needs | Checks |
|---|---|---|
| `host/test_bridge.py` | nothing | the companion over a fake serial board |
| `host/test_network.py` | nothing | the companion over a WebSocket: token, lookups, images |
| `host/test_board.py [--voice]` | the board on USB, companion stopped | real UI flows through the firmware's `@TEST` hooks |
| `host/capture_screens.py OUT --name NAME` | the board on USB | pixel-exact screen captures (the video's screens) |

## Where things live

- `main/`: firmware.
  - `pokemon_lookup.c`: UI, touch and buttons, recording, protocol, image cache, test hooks.
  - `wifi_link.c`: the Wi-Fi and WebSocket link, compiled only in the Wi-Fi build.
  - `Kconfig.projbuild`: the Wi-Fi build's settings.
- `host/`: the companion (`pokemon_bridge.py`), tests and tools; `host/macmini/`: the Mac mini service.
- `tools/`: `idf_env.sh` loads ESP-IDF; `build_wifi.sh` builds and flashes the Wi-Fi variant.
- `docs/`: deeper explanations ([how it works](docs/how-it-works.md)).
- `video/`: the demo video, built from real board captures.

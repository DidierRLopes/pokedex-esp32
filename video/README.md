# Launch video

A ~26 s demo of PokeDex at a card show, made with the
[launch-video](https://github.com/dzhng/skills) skill. It reads with the sound
off.

1. **Say a card**: the board arrives, you hold the screen, say "Venusaur".
2. **The answer**: the Poké Ball spins, then 1/9 appears. The real card lifts off the screen, marked not in your Pokévault collection, with its live price.
3. **Every printing**: PWR steps to 2/9, then 3/9: Base Set 2, already in your collection.
4. **All of them**: the nine Venusaur printings fan out, each with ✓/✗ and price; the one you own steps forward.
5. **On the go**: the laptop cable yanks out and a power bank plugs in. The spoken name then travels like a tracked parcel: Wi-Fi to the iPhone hotspot, up across the internet, through the Tailscale Funnel gate (its padlock opens for the token), to the Mac mini at home, where Whisper, the catalog, Pokévault and prices do the work. The answer (the real card, ✓, price) races back along the same route to the board.
6. **Lockup**: PokeDex, "Say a card. Know if you own it. Know what to pay.", the GitHub link.

```bash
npm install
npm run audio    # synthesize + master public/soundtrack.wav (-12 LUFS, -1 dBTP); needs macOS `say`
npm run studio   # scrub it in the browser
npm run draft    # half-scale review render
npm run render   # 1080p60 H.264, 320k AAC → out/pokedex-launch.mp4
npx remotion still src/index.ts LaunchVideo out/thumbnail.png --frame=0 --gl=angle   # the feed thumbnail
```

The world is three.js (via `@remotion/three`), so rendering needs a GPU-backed
browser (`--gl=angle`, already in the scripts). Renders and generated audio are
ignored; rerun `npm run audio` after a fresh clone.

## Nothing on the board is made up

- **Screens** (`public/screens/`) are pixel-exact captures from the real board: the firmware's `@TEST SNAPSHOT` hook sends the panel's pixels, and `host/capture_screens.py` walks the board through the lookup and saves each screen plus `results.json`, exactly what the board was sent. The only animation added is the one the firmware does itself: the Poké Ball spinner turning 0.6° every 33 ms.
- **The board** is built to Waveshare's dimension drawing: 37.6 × 45.2 × 15 mm case, 28.7 × 34.94 mm display, BOOT / USB-C / PWR down the right side. The USB-C cable stays in shot because the board works through the Mac.
- **Cards** (`public/cards/`) are the same pokemontcg.io images the companion shows, at high resolution.

Screens and card images contain official card art, so they are not in git.
To recreate them (stop any running companion first):

```bash
.voice-venv/bin/python host/capture_screens.py video/public/screens --name Venusaur
cd video/public && mkdir -p cards && python3 -c "import json; [print(m['id']) for m in json.load(open('screens/results.json'))['matches']]" \
  | while read id; do curl -sfL -o "cards/$id.hires.png" "https://images.pokemontcg.io/${id%-*}/${id#*-}_hires.png"; done
```

## Claims to preserve

- Prices are live TCGplayer data (via the psapop API) at capture time; they drift. Recapture before re-rendering if they must be current.
- ✓/✗ comes from the Pokévault collection the companion mirrors.
- The result screens came from a typed lookup (`@TEST QUERY`); a spoken lookup shows the same screens. The listening screen is a real capture.
- The on-the-go section shows the path, not a speed: only the local hotspot link has been measured, never the full cellular path to the Mac mini, so no timing is claimed for it. Its phone, power bank and Mac mini are generic models at real sizes (Mac mini in the M1 form), not product renders.
- The card art belongs to The Pokémon Company; this video is for internal use.

## One timing source

`src/cues.ts` holds every event time in song seconds at 120 BPM. The 3D world,
the type layers, and `audio/synth.ts` all read it, so moving a cue moves its
picture and its sound together. The first 0.3 s is a pre-roll that holds the
feed thumbnail from its own fixed camera (`POSTER_CAM` in `src/world/camera.ts`).

The audio is verified by measurement (ffmpeg `ebur128` loudness and a
spectrogram), not by ear.

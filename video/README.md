# Launch video

A ~31 s launch video for PokeDex, made with the
[launch-video](https://github.com/dzhng/skills) skill. The concept is a card
shop "pull": you ask for a card and the clerk flips through a long box and
pulls the exact one. The film is set on a card-show tabletop:

1. **Listen**: hold the board's screen and say "Gengar" (the real `say` voice from the benchmark); the waveform peels off the glass.
2. **Wrong**: a split-flap clock spells what plain speech-to-text heard, JUNGLE, under a ghosted GENGAR; the mismatched letters turn red.
3. **The pull**: a long box holds one card per name (736, with real set dividers). The voice sweeps along it; 48 cards rise; Gengar is pulled.
4. **Deliver**: the card whips onto the board's screen, which is rebuilt from the firmware's real layout, and the PWR button flips through the other printings.
5. **Proof**: 224 tiles (one per test clip) arc out of the board's screen onto the mat, flip to the old result (46%), then to the new one (99%); the camera finds the three real misses.
6. **Lockup**: a Poké Ball (the firmware's spinner, made solid) rolls in beside the board.

```bash
npm install
npm run audio    # synthesize + master public/soundtrack.wav (-12 LUFS, -1 dBTP); needs macOS `say`
npm run studio   # scrub it in the browser
npm run draft    # half-scale review render
npm run render   # 1080p60 H.264, 320k AAC → out/pokedex-launch.mp4
npm run still -- KeyArt out/key-art.png   # the headline-number still
npx remotion still src/index.ts LaunchVideo out/thumbnail.png --frame=0 --gl=angle   # the feed thumbnail
```

The world is three.js (via `@remotion/three`), so rendering needs a GPU-backed
browser (`--gl=angle`, already in the scripts). Renders and generated audio are
ignored; rerun `npm run audio` after a fresh clone.

## One timing source

`src/cues.ts` holds every event time in song seconds at 120 BPM. The 3D world,
the type layers, and `audio/synth.ts` all read it, and the two schedules with
many events (`src/flaps.ts` for the split-flap clock, `src/tiles.ts` for the
proof mosaic) are shared the same way, so every flap and tile has its own
sound. Moving a cue moves its picture and its sound together; add a visual
event as a cue first, then give it a sound. Everything is a pure function of
song time.

The first 0.3 s is a pre-roll that holds the board showing its result as the
feed thumbnail, from its own fixed camera (`POSTER_CAM` in `src/world/camera.ts`);
`PREROLL` shifts both picture and music.

## Claims to preserve

The numbers come from the companion's voice benchmark and catalog
(`src/data.json`, exported from the companion; regenerate rather than edit):

- **224 clips** = 56 card names × 4 synthetic macOS voices (Samantha, Daniel, Karen, Moira).
- **46%** = 103/224: Whisper `base`, transcribe then search (the original pipeline).
- **99%** = 221/224: Whisper `small.en` scoring all 736 names. The three misses shown red are the real ones (Kabutops/Daniel, Muk/Karen, Muk/Moira).
- The fair same-model comparison is disclosed on screen: `small.en` transcribe-then-search got 152/224.
- **~0.3 s** per lookup on the Mac (320 ms/clip in the benchmark).
- The per-clip results of the old pass weren't kept, so which 103 tiles turn green in the 46% pass is illustrative (the count is exact). The disclosure says so.
- Not yet measured through the board's microphone; the disclosure says so.
- **"JUNGLE"**: Whisper transcribed "Gengar" as "Jungle" for 5 of 8 test voices in the original pipeline.
- **736 → 48 → 1**: 736 distinct names; the shortlist keeps 48 after the first-token pass (`SHORTLIST` in `host/pokemon_bridge.py`). The extra rise of Gastly, Gligar and Jynx before the pull is staging, not a pipeline stage.
- The results on the board's screen (Gengar printings, prices, owned ✓/✗) are real catalog rows, with prices from the static catalog.
- The card faces are original and generic: no official card artwork.

The audio is verified by measurement (ffmpeg `ebur128` loudness, level jumps at
the cues, and a spectrogram), not by ear.

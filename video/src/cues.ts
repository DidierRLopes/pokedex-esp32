// The one timing source. The 3D world, the type layers, and the synthesized
// score all read it, so every hit on screen lands on a hit in the mix. Times
// are song seconds; the video adds PREROLL in front for the feed thumbnail.

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const PREROLL = 0.3;
export const FPS = 60;
export const SONG_END = 30.5;
export const DURATION = PREROLL + SONG_END;

// Arrangement.
export const SECTIONS = {
  listen: [0, 4], // macro on the glass: hold, say "Gengar"
  wrong: [4, 8], // the split-flap clock spells what plain speech-to-text heard
  pull: [8, 14], // the long box: every card name is tried against the voice
  deliver: [14, 18], // the pulled card streams onto the screen; side buttons flip
  build: [18, 20], // 224 test clips drop onto the mat
  proof: [20, 25], // 46% → 99%
  outro: [26, SONG_END], // Poké Ball rolls in; wordmark
} as const;

const range = (start: number, step: number, n: number) => Array.from({ length: n }, (_, i) => start + i * step);

export const SPOKEN = "Gengar";
export const WRONG = "JUNGLE";

export const CUE = {
  // 1 · Listen.
  press: 0.35, // finger lands on the glass: LISTENING
  voice: 1.0, // "Gengar" (macOS Samantha) plays here
  syllables: [1.0, 1.32],
  release: 2.5, // finger lifts: the waveform peels off the glass
  riser1: [2.75, 4.0],

  // 2 · Wrong: the split-flap clock lands on JUNGLE.
  wrong: 4.0,
  flapLand: range(4.5, 0.125, 6),
  buzz: 5.5,
  rewind: 6.5,
  riser2: [6.5, 8.0],

  // 3 · The pull: 736 names in the long box.
  drop: 8.0,
  count: 8.25,
  scan: [8.5, 10.0],
  shortlist: 10.0, // 48 cards rise
  finalists: [11.0, 11.25, 11.5, 11.75],
  pull: 12.0, // Gengar shoots up
  flip: 12.5,

  // 4 · Deliver: onto the screen, then the side buttons flip.
  toDevice: 14.0,
  rows: [14.45, 14.8],
  labels: [15.5, 15.75, 16.0, 16.25], // name, owned stamp, set, price sticker
  presses: [16.75, 17.25, 17.75],

  // 5 · Build: 224 clips rain onto the mat.
  tiles: [18.0, 19.75],
  riser3: [18.5, 20.0],

  // 6 · Proof.
  oldPass: 20.0, // transcribe, then search: 103/224
  newWave: [21.4, 22.0],
  newPass: 22.0, // pick from the card list: 221/224
  disclosure: 22.75,
  misses: [23.4, 23.65, 23.9], // the camera finds the three real misses

  // 7 · Outro.
  outro: 25.0,
  roll: [25.25, 26.5],
  lockup: 27.0,
  lockTag: 27.5,
  lockUrl: 28.0,
  finalHit: 29.0,
} as const;

// The shortlist keeps this many names after the first-token pass (host/pokemon_bridge.py).
export const SHORTLIST = 48;

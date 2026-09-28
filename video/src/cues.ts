// The one timing source. The 3D world, the type layers, and the synthesized
// score all read it, so every hit on screen lands on a hit in the mix. Times
// are song seconds; the video adds PREROLL in front for the feed thumbnail.

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const PREROLL = 0.3;
export const FPS = 60;
export const SONG_END = 19.5;
export const DURATION = PREROLL + SONG_END;

export const SPOKEN = "Venusaur";

export const SECTIONS = {
  intro: [0, 3], // the board arrives; hold the screen, say the card
  search: [3, 4.5], // the Poké Ball spins while the Mac works
  first: [4.5, 8], // 1/9: the real card, not owned, its price
  flip: [8, 12], // PWR steps through printings until the one you own
  fan: [12, 16], // every printing at once
  lockup: [16, SONG_END],
} as const;

export const CUE = {
  arrive: 0.0,
  press: 1.25, // finger on the glass: LISTENING
  word: 1.75, // "Venusaur" flies into the mic
  release: 2.75,
  search: 3.0,
  result: 4.5, // 1/9 on screen
  lift: 5.0, // the card rises off the screen
  notOwned: 5.75,
  price: 6.25,
  presses: [8.0, 9.5], // PWR, PWR → 2/9, 3/9
  owned: 10.0, // ✓ in your collection
  fan: 12.0,
  fanStep: 0.125, // one printing per 16th
  fanOwned: 13.5, // the one you own steps forward
  fanLine: 14.25,
  lockup: 16.0,
  lockTag: 16.5,
  lockVault: 17.0,
  lockUrl: 17.5,
  finalHit: 18.0,
} as const;

// Which captured result (0-based) is on the board's screen.
export const resultAt = (s: number) => CUE.presses.filter((p) => s >= p).length;

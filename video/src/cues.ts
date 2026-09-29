// The one timing source. The 3D world, the type layers, and the synthesized
// score all read it, so every hit on screen lands on a hit in the mix. Times
// are song seconds; the video adds PREROLL in front for the feed thumbnail.

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const PREROLL = 0.3;
export const FPS = 60;
export const SONG_END = 26.0;
export const DURATION = PREROLL + SONG_END;

export const SPOKEN = "Venusaur";

export const SECTIONS = {
  intro: [0, 3], // the board arrives; hold the screen, say the card
  search: [3, 4.5], // the Poké Ball spins while the Mac works
  first: [4.5, 8], // 1/9: the real card, not owned, its price
  flip: [8, 12], // PWR steps through printings until the one you own
  fan: [12, 16], // every printing at once
  connect: [16, 22.5], // on the go: power bank, hotspot, Funnel, Mac mini, and back
  lockup: [22.5, SONG_END],
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
  // On the go: the parcel-tracking route from the board to the Mac mini.
  connect: 16.0,
  unplug: 16.25, // the laptop cable yanks out
  bank: 16.55, // a power bank slides in
  plugIn: 16.9, // its cable snaps into the board
  rings: [17.1, 17.35, 17.6, 17.85], // Wi-Fi to the hotspot
  atPhone: 18.0,
  launch: 18.3, // up the route
  gate: 19.0, // through Tailscale Funnel: the padlock opens
  atMac: 19.7, // into the Mac mini at home
  chips: [19.9, 20.15, 20.4, 20.65], // Whisper · catalog · Pokévault · price
  reply: 21.0, // the answer leaves the Mac mini
  backOnBoard: 22.0,
  lockup: 22.5,
  lockTag: 23.0,
  lockVault: 23.5,
  lockUrl: 24.0,
  finalHit: 24.5,
} as const;

// Which captured result (0-based) is on the board's screen.
export const resultAt = (s: number) => CUE.presses.filter((p) => s >= p).length;

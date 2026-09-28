// What the board was actually sent for "Venusaur" (host/capture_screens.py
// records it next to the screen captures). Prices are live TCGplayer data via
// psapop at capture time; owned comes from the Pokévault collection.
import raw from "../public/screens/results.json";

export type Result = { id: string; name: string; number: string; set: string; total: number; price: number; owned: boolean };

export const RESULTS: Result[] = raw.matches;
export const OWNED_INDEX = RESULTS.findIndex((r) => r.owned);

export const price = (p: number) => (p <= 0 ? "$--" : `$${p.toFixed(2)}`);

// Every image the film draws, preloaded before the first frame.
export const SCREENS = {
  idle: "screens/01-idle.png",
  listening: "screens/02-listening.png",
  searching: "screens/03-searching-0.png",
  results: RESULTS.map((_, i) => `screens/04-result-${i + 1}.png`),
};
export const cardArt = (r: Result) => `cards/${r.id}.hires.png`;
export const IMAGES = [
  SCREENS.idle, SCREENS.listening, SCREENS.searching, ...SCREENS.results,
  ...RESULTS.map(cardArt), "pokeball.png",
];

// Real facts exported from the companion's catalog and the voice benchmark
// (see README "Claims to preserve"). Regenerate rather than hand-edit.
import raw from "./data.json";

export type Result = { id: string; name: string; number: string; set: string; total: number; price: number; owned: boolean };

export const NAMES: string[] = raw.names; // 736 distinct card names
export const RESULTS: Result[] = raw.results; // what "Gengar" returns, in order
export const SETS: string[] = raw.sets; // 18 vintage sets
export const CARD_COUNT: number = raw.cardCount; // 1796
export const BENCH_NAMES: string[] = raw.benchNames; // 56 names
export const BENCH_VOICES: string[] = raw.benchVoices; // 4 macOS voices
export const NEW_MISSES: string[][] = raw.newMisses; // the 3 clips name scoring got wrong

export const WINNER = NAMES.indexOf("Gengar");

export const price = (p: number) => (p <= 0 ? "$--" : `$${p.toFixed(2)}`);

// The split-flap clock's schedule: every flap, in song time. Shared by the
// clock in the world and the clack of each flap in the score.
import { CUE, WRONG } from "./cues.ts";

export const FLAP_CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const FLIP_DUR = 0.075;
export type Flip = { t: number; from: string; to: string; land?: boolean };

export const FLIPS: Flip[][] = Array.from({ length: 6 }, (_, m) => {
  const out: Flip[] = [];
  let cur = " ";
  const push = (t: number, to: string, land = false) => {
    out.push({ t, from: cur, to, land });
    cur = to;
  };
  // Spin from the start of the "wrong" section until this module lands.
  for (let t = CUE.wrong + m * 0.03, k = 0; t < CUE.flapLand[m] - 0.0001; t += FLIP_DUR, k++) {
    push(t, FLAP_CHARS[1 + ((k * 7 + m * 5) % 26)]);
  }
  push(CUE.flapLand[m], WRONG[m], true);
  // Rewind: spin back to blank.
  for (let t = CUE.rewind + m * 0.04, k = 0; k < 9; t += FLIP_DUR, k++) push(t, k === 8 ? " " : FLAP_CHARS[1 + ((k * 11 + m * 3) % 26)]);
  return out;
});

export function flapState(m: number, s: number) {
  let cur: Flip | null = null;
  for (const f of FLIPS[m]) if (f.t <= s) cur = f; else break;
  if (!cur) return { prev: " ", next: " ", p: 1 };
  return { prev: cur.from, next: cur.to, p: Math.min(1, Math.max(0, (s - cur.t) / FLIP_DUR)) };
}

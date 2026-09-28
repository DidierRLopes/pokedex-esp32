// The camera's flight, keyed on song time. Catmull-Rom through keys keeps it
// always moving.
import { CUE } from "../cues.ts";

type V3 = [number, number, number];
type Key = { t: number; pos: V3; look: V3 };

const KEYS: Key[] = [
  // 1 · The board arrives; creep in while it listens.
  { t: 0.0, pos: [4.0, 6.0, 26], look: [0, 3.4, 0] },
  { t: 1.2, pos: [1.2, 3.9, 15], look: [0, 3.25, 0] },
  { t: 2.9, pos: [0.4, 3.4, 11.5], look: [0, 3.25, 0] },
  // 2 · Close on the spinner.
  { t: 4.3, pos: [0.15, 3.35, 9.0], look: [0, 3.3, 0] },
  // 3 · Pull back and left as the card lifts off the screen.
  { t: 5.6, pos: [-2.0, 4.9, 24], look: [-3.1, 4.1, 0] },
  { t: 7.4, pos: [-1.2, 4.7, 22.5], look: [-2.9, 4.0, 0] },
  // 4 · Round to the right side to see PWR pressed.
  { t: 8.0, pos: [8.5, 4.2, 17.5], look: [-1.8, 3.7, 0] },
  { t: 9.6, pos: [7.4, 4.1, 16.0], look: [-1.8, 3.8, 0] },
  { t: 11.6, pos: [6.0, 4.6, 17.5], look: [-2.2, 4.0, 0] },
  // 5 · Crane up and back: every printing behind the board.
  { t: 13.0, pos: [0.0, 9.8, 42], look: [-0.3, 6.2, -8] },
  { t: 15.8, pos: [0.0, 9.3, 39.5], look: [-0.3, 6.2, -8] },
  // 6 · Lockup.
  { t: 17.0, pos: [0.0, 5.4, 21], look: [0.0, 3.9, -4] },
  { t: 21.0, pos: [0.0, 5.3, 19.5], look: [0.0, 3.9, -4] },
];

const cr = (p0: number, p1: number, p2: number, p3: number, u: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);

function sample(s: number, field: "pos" | "look"): V3 {
  let i = 0;
  while (i < KEYS.length - 2 && s >= KEYS[i + 1].t) i++;
  const k1 = KEYS[i], k2 = KEYS[i + 1];
  if (s <= k1.t) return [...k1[field]];
  if (s >= k2.t) return [...k2[field]];
  const k0 = i === 0 ? k1 : KEYS[i - 1];
  const k3 = i + 2 < KEYS.length ? KEYS[i + 2] : k2;
  const u = (s - k1.t) / (k2.t - k1.t);
  return [0, 1, 2].map((a) => cr(k0[field][a], k1[field][a], k2[field][a], k3[field][a], u)) as V3;
}

// The feed thumbnail: a 3/4 hero of the board showing the card you own.
const POSTER_CAM = { pos: [2.6, 4.4, 18.0] as V3, look: [-5.4, 3.4, 0] as V3 };

export function cameraAt(s: number, poster = false) {
  if (poster) return { pos: [...POSTER_CAM.pos] as V3, look: [...POSTER_CAM.look] as V3 };
  const pos = sample(s, "pos");
  const look = sample(s, "look");
  const d = s > CUE.lockup ? 0.02 : 0.05;
  pos[0] += Math.sin(s * 1.3) * d;
  pos[1] += Math.sin(s * 1.7 + 1) * d * 0.6;
  look[0] += Math.sin(s * 0.9 + 2) * d * 0.5;
  return { pos, look };
}

export const FOV = 34;

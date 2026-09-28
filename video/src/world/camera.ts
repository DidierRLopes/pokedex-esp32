// The camera's flight, keyed on song time. Catmull-Rom through keys keeps it
// always moving; a `cut` key starts a new path (hidden by the drop's flash).
import { CUE } from "../cues.ts";
import { cardX } from "./layout.ts";
import { WINNER } from "../data.ts";
import { heroPose } from "./hero.ts";

type V3 = [number, number, number];
type Key = { t: number; pos: V3; look: V3; cut?: boolean };

const gx = cardX(WINNER);

const KEYS: Key[] = [
  // Pre-roll thumbnail sits on the hero framing (see Video.tsx), so start here.
  { t: -0.3, pos: [5.2, 3.9, 11.4], look: [4, 3.5, 0] },
  // 1 · Listen: macro on the glass, slow push.
  { t: 0.0, pos: [5.2, 3.9, 11.4], look: [4, 3.5, 0] },
  { t: 2.45, pos: [4.3, 3.6, 8.6], look: [4, 3.35, 0] },
  // Follow the waveform off the glass to the clock.
  { t: 3.2, pos: [3.4, 4.6, 9.5], look: [0.5, 2.6, -2.5] },
  { t: 4.0, pos: [-4.3, 2.5, 3.6], look: [-5, 1.9, -7] },
  // 2 · Wrong: creep in on JUNGLE.
  { t: 5.5, pos: [-4.9, 2.3, 2.6], look: [-5, 1.95, -7] },
  { t: 6.5, pos: [-5.2, 2.2, 2.2], look: [-5, 1.95, -7] },
  { t: 7.2, pos: [-7.5, 8.5, 8.5], look: [-18, 2.5, 3] },
  { t: 7.95, pos: [-13, 9.5, 11], look: [-25, 2.5, 3] },
  // 3 · The pull: low at the end of the long box, one-point perspective.
  { t: 8.0, pos: [-41.5, 5.6, 3.0], look: [-22, 3.4, 3.0], cut: true },
  { t: 9.9, pos: [-33.5, 5.4, 6.2], look: [-21, 3.5, 3.0] },
  { t: 11.0, pos: [-13.5, 9.5, 12.5], look: [-24, 3.4, 3] },
  { t: 11.95, pos: [gx + 3.4, 6.6, 12.0], look: [gx, 4.4, 3] },
  { t: 12.6, pos: [gx + 3.0, 8.9, 11.6], look: [gx, 7.8, 3] },
  { t: 13.9, pos: [gx + 3.8, 9.1, 11.0], look: [gx, 8.0, 3] },
  // 4 · Deliver: whip after the card to the board, then a 3/4 hero.
  { t: 14.45, pos: [4.5, 3.5, 9.4], look: [4, 2.95, 0] },
  { t: 15.3, pos: [4.9, 3.1, 8.6], look: [4, 2.6, 0] },
  { t: 16.3, pos: [4.5, 2.4, 6.8], look: [4.0, 1.95, 0.3] },
  { t: 16.7, pos: [6.2, 3.2, 7.3], look: [4.1, 2.8, 0] },
  { t: 17.85, pos: [6.4, 3.25, 7.2], look: [4.1, 2.8, 0] },
  { t: 18.4, pos: [10, 6.5, 14], look: [4, 1.5, 6] },
  // 5 · Build: crane up over the mat.
  { t: 19.6, pos: [4, 20.5, 17.5], look: [4, 0, 12.3] },
  // 6 · Proof: slow drift over the mosaic.
  { t: 22.8, pos: [4.3, 19.8, 17.3], look: [4, 0, 12.3] },
  { t: 24.0, pos: [8.8, 10.5, 24.5], look: [8.6, 0, 12.4] },
  { t: 25.0, pos: [8.2, 10.2, 23.2], look: [8.0, 0.2, 11.8] },
  // 7 · Outro: swing down to the hero with the Poké Ball.
  { t: 25.7, pos: [7.5, 6.5, 19.0], look: [5.8, 2.6, 0.5] },
  { t: 26.6, pos: [5.6, 4.4, 17.2], look: [5.6, 3.35, 0.5] },
  { t: 30.8, pos: [5.6, 4.2, 14.6], look: [5.6, 3.4, 0.5] },
];

const cr = (p0: number, p1: number, p2: number, p3: number, u: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);

function sample(s: number, field: "pos" | "look"): V3 {
  let i = 0;
  while (i < KEYS.length - 2 && s >= KEYS[i + 1].t) i++;
  const k1 = KEYS[i], k2 = KEYS[i + 1];
  if (s <= k1.t) return [...k1[field]];
  if (s >= k2.t) return [...k2[field]];
  if (k2.cut) {
    // Accelerate away into the cut.
    const u = (s - k1.t) / (k2.t - k1.t);
    return [...k1[field]].map((v, a) => v + (k1[field][a] - (KEYS[i - 1]?.[field][a] ?? v)) * u * u * 0.4) as V3;
  }
  const k0 = k1.cut || i === 0 ? k1 : KEYS[i - 1];
  const k3 = i + 2 < KEYS.length && !KEYS[i + 2].cut ? KEYS[i + 2] : k2;
  const u = (s - k1.t) / (k2.t - k1.t);
  return [0, 1, 2].map((a) => cr(k0[field][a], k1[field][a], k2[field][a], k3[field][a], u)) as V3;
}

// The feed thumbnail's framing: a 3/4 hero of the board showing its result.
const POSTER_CAM = { pos: [7.6, 4.1, 10.8] as V3, look: [2.6, 2.75, 0] as V3 };

export function cameraAt(s: number, poster = false) {
  if (poster) return { pos: [...POSTER_CAM.pos] as V3, look: [...POSTER_CAM.look] as V3 };
  const pos = sample(s, "pos");
  const look = sample(s, "look");
  // Chase the pulled card across the table: aim at it while it flies.
  const chase = Math.sin(Math.PI * Math.min(1, Math.max(0, (s - CUE.toDevice + 0.1) / 0.55)));
  if (chase > 0) {
    const card = heroPose(s).pos;
    look[0] += (card.x - look[0]) * chase;
    look[1] += (card.y - look[1]) * chase;
    look[2] += (card.z - look[2]) * chase;
  }
  // Handheld drift; none in the lockup hold.
  const d = s > CUE.lockup ? 0.015 : 0.035;
  pos[0] += Math.sin(s * 1.3) * d;
  pos[1] += Math.sin(s * 1.7 + 1) * d * 0.6;
  look[0] += Math.sin(s * 0.9 + 2) * d * 0.5;
  // Overshoot on arrival after the drop cut.
  if (s >= CUE.drop && s < CUE.drop + 0.6) pos[2] += Math.sin((s - CUE.drop) * 18) * 0.6 * Math.exp(-(s - CUE.drop) / 0.15);
  return { pos, look };
}

// Wider lens for the long-box perspective, tighter for the macro.
const ramp = (s: number, a: number, b: number) => Math.min(1, Math.max(0, (s - a) / (b - a)));
export function fovAt(s: number, poster = false) {
  if (poster) return 30;
  if (s < CUE.drop) return 30 + 4 * ramp(s, 3.2, 4.0);
  return 48 - 12 * ramp(s, 9.9, 11.0);
}

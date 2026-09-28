// Synthesizes the soundtrack from the cue sheet: a 120 BPM chip-pop bed plus
// one sound per on-screen event, and the spoken "Gengar" (macOS `say`, the
// same voice the benchmark used) at its cue. Writes public/raw.wav;
// master.ts loudnorms it.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAR, BEAT, CUE, DURATION, PREROLL, SECTIONS, SONG_END, SPOKEN } from "../src/cues.ts";
import { FLIPS } from "../src/flaps.ts";
import { TILE_COUNT, newWave, oldWave, tileCell, tileLand } from "../src/tiles.ts";

const SR = 48000;
const N = Math.ceil(DURATION * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const sendL = new Float32Array(N); // reverb send
const sendR = new Float32Array(N);

// ---------- helpers ----------
const at = (s: number) => Math.round((s + PREROLL) * SR); // song time → sample
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const inRange = (s: number, [a, b]: readonly number[]) => s >= a && s < b;
let seed = 1;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

type Voice = (i: number, t: number) => number;
function place(s: number, dur: number, fn: Voice, gain = 1, pan = 0, send = 0) {
  const start = at(s);
  const len = Math.round(dur * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  for (let i = 0; i < len; i++) {
    const k = start + i;
    if (k < 0 || k >= N) continue;
    const v = fn(i, i / SR);
    L[k] += v * gl;
    R[k] += v * gr;
    sendL[k] += v * gl * send;
    sendR[k] += v * gr * send;
  }
}
function svf(mode: "lp" | "bp" | "hp", q = 0.7) {
  let low = 0, band = 0;
  return (x: number, cutoff: number) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR / 6)) / SR);
    low += f * band;
    const high = x - low - band / q;
    band += f * high;
    return mode === "lp" ? low : mode === "bp" ? band : high;
  };
}
const saw = (ph: number) => 2 * (ph - Math.floor(ph + 0.5));
const square = (ph: number, duty = 0.5) => (ph - Math.floor(ph) < duty ? 1 : -1);
const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d));

// ---------- arrangement ----------
// vi–IV–I–V in C (Am F C G), one chord per bar.
const CHORDS = [
  { root: 45, notes: [57, 60, 64, 69] },
  { root: 41, notes: [57, 60, 65, 69] },
  { root: 36, notes: [55, 60, 64, 67] },
  { root: 43, notes: [55, 59, 62, 67] },
];
const chordAt = (s: number) => CHORDS[Math.floor(Math.max(0, s) / BAR) % 4];
const full = (s: number) => inRange(s, SECTIONS.pull) || inRange(s, SECTIONS.deliver) || inRange(s, SECTIONS.proof);
const half = (s: number) => inRange(s, SECTIONS.wrong) && s < CUE.rewind;
const kicks: number[] = [];
for (let s = 0; s < SONG_END; s += BEAT) {
  const b = Math.round(s / BEAT);
  if (full(s) || (half(s) && b % 2 === 0)) kicks.push(s);
}
function duck(s: number) {
  let last = -1;
  for (const k of kicks) if (k <= s) last = k; else break;
  if (last < 0 || s - last > 0.4) return 1;
  return 1 - 0.7 * Math.exp(-(s - last) / 0.11);
}

// ---------- drums ----------
function kick(s: number, gain = 1) {
  place(s, 0.45, (_, t) => {
    const ph = 48 * t + (130 * 0.03) * (1 - Math.exp(-t / 0.03));
    const click = t < 0.004 ? noise() * (1 - t / 0.004) * 0.5 : 0;
    return Math.sin(2 * Math.PI * ph) * env(t, 0.001, 0.16) + click;
  }, 0.95 * gain);
}
function clap(s: number, gain = 1) {
  const bp = svf("bp", 1.2);
  place(s, 0.3, (_, t) => {
    const bursts = [0, 0.011, 0.022].reduce((a, o) => a + (t >= o ? Math.exp(-(t - o) / 0.006) : 0), 0);
    return bp(noise() * (bursts * 0.6 + Math.exp(-t / 0.09)), 1400) * 1.6;
  }, 0.5 * gain, 0, 0.35);
}
function hat(s: number, open = false, gain = 1, pan = 0) {
  const hp = svf("hp", 0.8);
  place(s, open ? 0.25 : 0.06, (_, t) => hp(noise(), 8000) * env(t, 0.0005, open ? 0.07 : 0.018), 0.2 * gain, pan);
}

// ---------- tonal ----------
function bassNote(s: number, midi: number, dur: number, gain = 0.34) {
  const lp = svf("lp", 1.1);
  place(s, dur, (_, t) => {
    const f = hz(midi);
    const v = saw(f * t) + 0.6 * Math.sin(2 * Math.PI * f * 0.5 * t);
    return lp(v, 180 + 1400 * Math.exp(-t / 0.08)) * env(t, 0.004, dur * 0.6) * duck(s + t);
  }, gain);
}
function pad(s0: number, s1: number, cutoffAt: (s: number) => number, gain: number) {
  for (let b = Math.floor(s0 / BAR); b * BAR < s1; b++) {
    const s = Math.max(s0, b * BAR);
    const e = Math.min(s1, (b + 1) * BAR);
    const { notes } = chordAt(s);
    const lpL = svf("lp", 0.9), lpR = svf("lp", 0.9);
    const detune = [-0.12, 0, 0.11];
    const len = e - s;
    const start = at(s);
    for (let i = 0; i < len * SR; i++) {
      const t = i / SR;
      let vl = 0, vr = 0;
      for (const n of notes) for (const d of detune) {
        vl += saw(hz(n + d) * t + d);
        vr += saw(hz(n + d) * 1.002 * t + d * 3);
      }
      const edge = Math.min(1, t / 0.02, (len - t) / 0.02);
      const c = cutoffAt(s + t);
      const g = (edge * duck(s + t) * gain) / 12;
      const k = start + i;
      if (k >= N) break;
      const l = lpL(vl, c) * g, r = lpR(vr, c) * g;
      L[k] += l; R[k] += r; sendL[k] += l * 0.5; sendR[k] += r * 0.5;
    }
  }
}
// 8-bit pulse lead: the Game Boy nod.
function chip(s: number, midi: number, dur: number, gain = 0.1, pan = 0, duty = 0.25) {
  place(s, dur + 0.05, (_, t) => {
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 6 * Math.max(0, t - 0.08));
    return square(hz(midi) * vib * t, duty) * env(t, 0.003, dur * 0.7) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.02)) * duck(s + t);
  }, gain, pan, 0.3);
}
function pluck(s: number, midi: number, gain: number, bright: number, pan: number) {
  const lp = svf("lp", 1.4);
  place(s, 0.22, (_, t) => {
    const f = hz(midi);
    const sq = square(f * t) * 0.6 + saw(f * 2.001 * t) * 0.4;
    return lp(sq, 300 + bright * Math.exp(-t / 0.05)) * env(t, 0.002, 0.07) * duck(s + t);
  }, gain, pan, 0.4);
}

// ---------- FX ----------
function riser(s0: number, s1: number, gain = 1) {
  const bp = svf("bp", 2.5);
  const dur = s1 - s0;
  place(s0, dur, (_, t) => {
    const p = t / dur;
    return (bp(noise(), 400 + 9000 * p * p) * 1.3 + saw(hz(48 + 24 * p) * t * (1 + p)) * 0.25 * p) * p * p;
  }, 0.5 * gain, 0, 0.3);
}
function impact(s: number, gain = 1) {
  const lp = svf("lp", 0.7);
  place(s, 2.2, (_, t) => {
    const boom = Math.sin(2 * Math.PI * (30 * t + 60 * 0.12 * (1 - Math.exp(-t / 0.12)))) * env(t, 0.002, 0.5);
    const crash = lp(noise(), 2000 + 7000 * Math.exp(-t / 0.3)) * env(t, 0.001, 0.45);
    return boom * 0.9 + crash * 0.55;
  }, 0.7 * gain, 0, 0.5);
}
function whoosh(s: number, dur = 0.45, gain = 1, up = true) {
  const bp = svf("bp", 1.6);
  place(s, dur, (_, t) => {
    const p = t / dur;
    return bp(noise(), up ? 300 + 5000 * p * p : 5000 - 4700 * p) * Math.sin(Math.PI * Math.min(1, p)) ** 1.5;
  }, 0.45 * gain, 0, 0.3);
}
function pop(s: number, pitch = 1, gain = 1, pan = 0) {
  place(s, 0.09, (_, t) => Math.sin(2 * Math.PI * (500 + 700 * Math.exp(-t / 0.012)) * pitch * t) * env(t, 0.001, 0.025), 0.32 * gain, pan, 0.25);
}
function tick(s: number, pitch = 1, gain = 1, pan = 0) {
  const bp = svf("bp", 3);
  place(s, 0.03, (_, t) => (bp(noise(), 3200 * pitch) * 2 + Math.sin(2 * Math.PI * 2600 * pitch * t) * 0.5) * env(t, 0.0005, 0.006), 0.26 * gain, pan);
}
// A split-flap leaf slapping down: plastic click with a little body.
function clack(s: number, gain = 1, pan = 0) {
  const bp = svf("bp", 2.2);
  const f0 = 900 + noise() * 200;
  place(s, 0.05, (_, t) => (bp(noise(), f0 + 1500) * 1.6 + Math.sin(2 * Math.PI * f0 * 0.3 * t) * 0.6) * env(t, 0.0003, 0.007), 0.3 * gain, pan);
}
function buzzer(s: number, dur: number) {
  const lp = svf("lp", 1.2);
  place(s, dur, (_, t) => lp(square(hz(40) * t) + square(hz(40.3) * t) + square(hz(47) * t) * 0.6, 1600) * env(t, 0.005, dur * 0.8) * (t < dur - 0.03 ? 1 : 0.3), 0.3, 0, 0.2);
}
function tapeRewind(s: number, dur: number) {
  const bp = svf("bp", 3);
  place(s, dur, (_, t) => {
    const p = t / dur;
    const f = 2400 * (1 - p * 0.8) + 300 * Math.sin(t * 90);
    return bp(noise(), f) * 1.4 * Math.sin(Math.PI * p) + saw(hz(70 - 30 * p) * t) * 0.15 * (1 - p);
  }, 0.4, 0, 0.3);
}
function checkBlip(s: number, gain = 1) {
  place(s, 0.22, (_, t) => {
    const f = t < 0.06 ? hz(84) : hz(88);
    return square(f * t, 0.5) * env(t < 0.06 ? t : t - 0.06, 0.002, 0.05) * 0.5;
  }, 0.3 * gain, 0.1, 0.4);
}
function stamp(s: number) {
  const lp = svf("lp", 1);
  place(s, 0.3, (_, t) => lp(Math.sign(Math.sin(2 * Math.PI * 110 * Math.exp(-t / 0.2) * t)) + noise() * 0.4, 1200) * env(t, 0.001, 0.07), 0.5, 0, 0.2);
}
function ding(s: number, midi = 96, gain = 1) {
  place(s, 1.6, (_, t) => {
    const f = hz(midi);
    return (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / 0.2) + 0.2 * Math.sin(2 * Math.PI * f * 5.4 * t) * Math.exp(-t / 0.08)) * env(t, 0.002, 0.45);
  }, 0.16 * gain, 0, 0.6);
}
function sparkle(s: number, midi = 100, gain = 1, pan = 0) {
  place(s, 0.6, (_, t) => (Math.sin(2 * Math.PI * hz(midi) * t) + 0.5 * Math.sin(2 * Math.PI * hz(midi + 7) * t)) * env(t, 0.002, 0.12), 0.12 * gain, pan, 0.8);
}
function subDrop(s: number, gain = 1) {
  place(s, 1.2, (_, t) => Math.sin(2 * Math.PI * (28 * t + 40 * 0.4 * (1 - Math.exp(-t / 0.4)))) * env(t, 0.005, 0.5), 0.6 * gain);
}
function rumble(s: number, dur: number, gain = 1) {
  const lp = svf("lp", 0.8);
  place(s, dur, (_, t) => lp(noise(), 110 + 260 * Math.abs(Math.sin(t * 9))) * 3 * Math.sin(Math.PI * Math.min(1, t / dur)), 0.45 * gain);
}
// Serial data: a fast 8-bit chirp stream.
function data(s0: number, s1: number, gain = 1) {
  place(s0, s1 - s0, (i, t) => {
    const step = Math.floor(t * 90);
    const f = 1200 + ((step * 7919) % 13) * 180;
    return square(f * t, 0.5) * 0.4 * (0.6 + 0.4 * Math.sin(t * 40)) * Math.min(1, t / 0.02, (s1 - s0 - t) / 0.03);
  }, 0.12 * gain, 0.2, 0.2);
}

// ---------- the spoken input ----------
function spoken(s: number, text: string, gain = 1) {
  const dir = mkdtempSync(join(tmpdir(), "pokedex-say-"));
  const file = join(dir, "say.wav");
  const r = spawnSync("say", ["-v", "Samantha", "--data-format=LEI16@48000", "-o", file, text]);
  if (r.status !== 0) {
    console.warn("say failed; spoken cue skipped");
    return;
  }
  const buf = readFileSync(file);
  let o = 12;
  while (o < buf.length - 8 && buf.toString("ascii", o, o + 4) !== "data") o += 8 + buf.readUInt32LE(o + 4);
  const len = buf.readUInt32LE(o + 4) / 2;
  const pcm = new Float32Array(len);
  for (let i = 0; i < len; i++) pcm[i] = buf.readInt16LE(o + 8 + i * 2) / 32768;
  // Skip the leading silence so the first syllable lands on the cue.
  let lead = 0;
  while (lead < len && Math.abs(pcm[lead]) < 0.02) lead++;
  const hp = svf("hp", 0.7);
  place(s, (len - lead) / SR, (i) => hp(pcm[lead + i] ?? 0, 140) * 1.1, 0.9 * gain, 0, 0.35);
}

// ---------- the bed ----------
for (const k of kicks) kick(k, [CUE.drop, CUE.oldPass, CUE.newPass].some((t) => Math.abs(t - k) < 0.01) ? 1.2 : 1);
for (let s = 0; s < SONG_END; s += BEAT) {
  const beat = Math.round(s / BEAT) % 4;
  if (full(s) && (beat === 1 || beat === 3)) clap(s);
  if (half(s) && beat === 2) clap(s, 0.8);
  // Heartbeat while listening.
  if (inRange(s, SECTIONS.listen) && s > 0.4 && beat % 2 === 0) place(s, 0.3, (_, t) => Math.sin(2 * Math.PI * 52 * t) * env(t, 0.004, 0.09), 0.45);
}
for (let s = 0; s < SONG_END; s += BEAT / 4) {
  const sixteenth = Math.round(s / (BEAT / 4)) % 4;
  if (full(s)) {
    if (sixteenth === 2) hat(s, true, 0.8, 0.2);
    else hat(s, false, sixteenth === 0 ? 0.5 : 0.75, -0.25);
  } else if (half(s) && sixteenth === 2) hat(s, false, 0.6, 0.2);
  else if (inRange(s, SECTIONS.outro) && s < CUE.lockup && sixteenth === 2) hat(s, false, 0.35, 0.2);
}
// Snare roll through the build.
for (let s = SECTIONS.build[0]; s < SECTIONS.build[1]; ) {
  const p = (s - SECTIONS.build[0]) / (SECTIONS.build[1] - SECTIONS.build[0]);
  clap(s, 0.3 + 0.7 * p);
  s += p < 0.5 ? BEAT : p < 0.75 ? BEAT / 2 : BEAT / 4;
}
for (let s = 0; s < SONG_END; s += BEAT / 2) {
  if (!full(s) && !half(s)) continue;
  const { root } = chordAt(s);
  const off = Math.round(s / (BEAT / 2)) % 2 === 1;
  bassNote(s, root + (off ? 12 : 0), BEAT / 2);
}
pad(0, SONG_END, (s) => {
  if (s < 4) return 280 + 900 * (s / 4) ** 2;
  if (inRange(s, SECTIONS.wrong)) return s < CUE.rewind ? 900 : 900 + 3500 * ((s - CUE.rewind) / 1) ** 2;
  if (inRange(s, SECTIONS.build)) return 1500 + 3500 * ((s - 18) / 2) ** 2;
  if (s >= CUE.lockup) return 3200;
  return 2600;
}, 1);
// Arp in the drops.
for (let s = 0; s < CUE.lockup; s += BEAT / 4) {
  const soft = inRange(s, SECTIONS.outro) || inRange(s, SECTIONS.build);
  if (!full(s) && !soft) continue;
  const { notes } = chordAt(s);
  const i = Math.round(s / (BEAT / 4));
  pluck(s, notes[[0, 1, 2, 3, 2, 1, 3, 2][i % 8]] + 12, soft ? 0.08 : 0.11, soft ? 1500 : 3200, i % 2 ? 0.35 : -0.35);
}
// Chip lead: an original two-bar hook over the chords, in the pull and the proof.
const HOOK: [number, number, number][] = [ // [beat offset, scale step, length in beats]
  [0, 4, 0.5], [0.5, 2, 0.5], [1, 4, 0.5], [1.5, 5, 0.5], [2, 7, 1], [3, 5, 0.5], [3.5, 4, 0.5],
  [4, 2, 0.5], [4.5, 4, 0.5], [5, 2, 0.5], [5.5, 0, 0.5], [6, 1, 1.5],
];
const SCALE = [69, 71, 72, 74, 76, 77, 79, 81]; // A minor
for (const [s0, s1] of [[CUE.drop, CUE.toDevice], [CUE.newPass, SECTIONS.proof[1]]] as const) {
  for (let base = s0; base < s1 - 0.01; base += BAR * 2) {
    for (const [b, step, len] of HOOK) {
      const s = base + b * BEAT;
      if (s >= s1) break;
      chip(s, SCALE[step], len * BEAT * 0.9, 0.07, -0.15);
      chip(s + 0.004, SCALE[step] - 12, len * BEAT * 0.9, 0.035, 0.2, 0.5);
    }
  }
}

// ---------- cue sounds ----------
whoosh(-PREROLL, PREROLL + 0.05, 0.8);
// 1 · Listen
tick(CUE.press, 0.7, 1.4);
pop(CUE.press, 0.7, 1.2);
spoken(CUE.voice, SPOKEN);
pop(CUE.release, 1.2, 1.2);
whoosh(CUE.release, 1.4, 1.1);
riser(CUE.riser1[0], CUE.riser1[1], 0.9);
// 2 · Wrong: every flap clacks; landings hit harder.
impact(CUE.wrong, 0.5);
FLIPS.forEach((flips, m) => flips.forEach((f) => clack(f.t + 0.02, f.land ? 1.8 : 0.55, (m - 2.5) / 4)));
buzzer(CUE.buzz, 0.55);
tapeRewind(CUE.rewind, 0.9);
riser(CUE.riser2[0], CUE.riser2[1], 1.1);
// 3 · The pull
impact(CUE.drop, 1.2);
subDrop(CUE.drop);
whoosh(CUE.scan[0] - 0.1, CUE.scan[1] - CUE.scan[0] + 0.2, 0.9);
for (let i = 0; i < 18; i++) tick(CUE.scan[0] + ((i + 0.5) / 18) * (CUE.scan[1] - CUE.scan[0]), 0.9 + i * 0.02, 0.7, -0.6 + (i / 18) * 1.2);
for (let r = 0; r < 48; r++) pluck(CUE.shortlist + (r / 48) * 1.4, CHORDS[1].notes[r % 4] + 12 + 12 * Math.floor(r / 16), 0.07, 4000, ((r % 5) - 2) / 3);
CUE.finalists.forEach((s, i) => { pop(s, 0.7 + i * 0.15, 1.3); tick(s, 1.2 + i * 0.1); });
impact(CUE.pull, 0.9);
whoosh(CUE.pull - 0.05, 0.5, 1.2);
[0, 0.06, 0.12, 0.2].forEach((d, i) => sparkle(CUE.pull + d, 96 + i * 3, 1.3, (i - 1.5) / 2));
whoosh(CUE.flip, 0.6, 0.8);
ding(CUE.flip + 0.1, 93, 0.9);
// 4 · Deliver
whoosh(CUE.toDevice - 0.05, 0.5, 1.2);
stamp(CUE.toDevice + 0.45);
data(CUE.rows[0], CUE.rows[1]);
pop(CUE.labels[0], 1.0, 1.1);
checkBlip(CUE.labels[1], 1.3);
pop(CUE.labels[2], 1.15, 0.9);
stamp(CUE.labels[3]);
pop(CUE.labels[3], 1.3, 0.8);
CUE.presses.forEach((s) => { tick(s, 0.6, 1.6, 0.4); checkBlip(s + 0.03, 0.6); });
// 5 · Build: tiles land (grouped so the clatter stays musical).
for (let k = 0; k < TILE_COUNT; k += 3) tick(tileLand(k), 0.8 + (tileCell(k).row / 8) * 0.5, 0.5, (tileCell(k).col - 14) / 16);
riser(CUE.riser3[0], CUE.riser3[1], 1.2);
// 6 · Proof
impact(CUE.oldPass, 0.9);
buzzer(CUE.oldPass + 0.05, 0.35);
for (let c = 0; c < 28; c += 2) clack(oldWave(c), 0.5, (c - 14) / 16);
for (let c = 0; c < 28; c += 2) pluck(newWave(c), SCALE[Math.floor(c / 4)] + 12, 0.09, 4500, (c - 14) / 16);
impact(CUE.newPass, 1.4);
subDrop(CUE.newPass, 1.1);
for (const n of CHORDS[2].notes) chip(CUE.newPass, n + 12, 0.8, 0.05);
pop(CUE.disclosure, 0.9, 0.6);
whoosh(CUE.misses[0] - 0.9, 0.9, 0.8, false);
CUE.misses.forEach((s, i) => { pop(s, 0.6 + i * 0.08, 1.2, 0.3); tick(s, 0.7, 0.8); });
// Letters that miss: a low blip each as the ghosted GENGAR appears.
[0, 1, 4, 5].forEach((m, i) => checkBlip(CUE.buzz + 0.1 + i * 0.06, 0.25));
// 7 · Outro
riser(CUE.outro - 0.5, CUE.outro, 0.4);
rumble(CUE.roll[0], CUE.roll[1] - CUE.roll[0] + 0.2);
tick(CUE.roll[1], 0.5, 1.5);
impact(CUE.lockup, 0.8);
subDrop(CUE.lockup, 0.7);
ding(CUE.lockup + 0.05, 96, 1.1);
pop(CUE.lockTag, 1);
pop(CUE.lockUrl, 1.3);
for (const n of CHORDS[2].notes) pluck(CUE.finalHit, n + 12, 0.2, 5000, 0);
chip(CUE.finalHit, 84, 0.25, 0.08);
chip(CUE.finalHit + 0.25, 88, 0.25, 0.08);
chip(CUE.finalHit + 0.5, 91, 0.8, 0.08);
bassNote(CUE.finalHit, 36, 1.2);
impact(CUE.finalHit, 0.4);

// ---------- reverb (small Schroeder) + mixdown ----------
function reverb(inp: Float32Array, spread: number) {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d: d + spread, buf: new Float32Array(d + spread), i: 0, lp: 0 }));
  for (let k = 0; k < N; k++) {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.6 + c.lp * 0.4;
      c.buf[c.i] = inp[k] + c.lp * 0.8;
      c.i = (c.i + 1) % c.d;
      acc += y;
    }
    out[k] = acc * 0.25;
  }
  for (const d of [225, 556]) {
    const buf = new Float32Array(d);
    let i = 0;
    for (let k = 0; k < N; k++) {
      const b = buf[i];
      const y = -out[k] + b;
      buf[i] = out[k] + b * 0.5;
      i = (i + 1) % d;
      out[k] = y;
    }
  }
  return out;
}
const rvL = reverb(sendL, 0), rvR = reverb(sendR, 23);
const fadeStart = at(SONG_END - 0.8);
for (let k = 0; k < N; k++) {
  const fade = k > fadeStart ? Math.max(0, 1 - (k - fadeStart) / (N - fadeStart)) : 1;
  L[k] = Math.tanh((L[k] + rvL[k] * 0.35) * 0.9) * fade;
  R[k] = Math.tanh((R[k] + rvR[k] * 0.35) * 0.9) * fade;
}

// ---------- write 24-bit WAV ----------
const bytes = 3;
const buf = Buffer.alloc(44 + N * 2 * bytes);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 2 * bytes, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * bytes, 28); buf.writeUInt16LE(2 * bytes, 32); buf.writeUInt16LE(24, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 2 * bytes, 40);
let o = 44;
for (let k = 0; k < N; k++) for (const ch of [L, R]) {
  const v = Math.round(Math.max(-1, Math.min(1, ch[k])) * 8388607);
  buf.writeIntLE(v, o, 3); o += 3;
}
writeFileSync(new URL("../public/raw.wav", import.meta.url), buf);
console.log(`raw.wav ${(N / SR).toFixed(2)}s`);

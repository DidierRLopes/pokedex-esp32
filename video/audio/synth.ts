// Synthesizes the soundtrack from the cue sheet: a 120 BPM chip-pop bed plus
// one sound per on-screen event, and the spoken "Venusaur" (macOS `say`) at
// its cue. Writes public/raw.wav; master.ts loudnorms it. The film also reads
// with the sound off.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAR, BEAT, CUE, DURATION, PREROLL, SECTIONS, SONG_END, SPOKEN } from "../src/cues.ts";

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
// I–V–vi–IV in D, one chord per bar: bright, a little heroic.
const CHORDS = [
  { root: 38, notes: [62, 66, 69, 74] },
  { root: 45, notes: [61, 64, 69, 73] },
  { root: 47, notes: [62, 66, 71, 74] },
  { root: 43, notes: [62, 67, 71, 74] },
];
const chordAt = (s: number) => CHORDS[Math.floor(Math.max(0, s) / BAR) % 4];
const full = (s: number) =>
  inRange(s, SECTIONS.first) || inRange(s, SECTIONS.flip) || inRange(s, SECTIONS.fan) || inRange(s, SECTIONS.connect);
const kicks: number[] = [];
for (let s = 0; s < SONG_END; s += BEAT) if (full(s)) kicks.push(s);
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
function buzzer(s: number, dur: number) {
  const lp = svf("lp", 1.2);
  place(s, dur, (_, t) => lp(square(hz(40) * t) + square(hz(40.3) * t) + square(hz(47) * t) * 0.6, 1600) * env(t, 0.005, dur * 0.8) * (t < dur - 0.03 ? 1 : 0.3), 0.3, 0, 0.2);
}
function checkBlip(s: number, gain = 1) {
  place(s, 0.22, (_, t) => {
    const f = t < 0.06 ? hz(84) : hz(88);
    return square(f * t, 0.5) * env(t < 0.06 ? t : t - 0.06, 0.002, 0.05) * 0.5;
  }, 0.3 * gain, 0.1, 0.4);
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
for (const k of kicks) kick(k, [CUE.result, CUE.owned, CUE.fan].some((t) => Math.abs(t - k) < 0.01) ? 1.2 : 1);
for (let s = 0; s < SONG_END; s += BEAT) {
  const beat = Math.round(s / BEAT) % 4;
  if (full(s) && (beat === 1 || beat === 3)) clap(s);
}
for (let s = 0; s < SONG_END; s += BEAT / 4) {
  const sixteenth = Math.round(s / (BEAT / 4)) % 4;
  if (full(s)) {
    if (sixteenth === 2) hat(s, true, 0.8, 0.2);
    else hat(s, false, sixteenth === 0 ? 0.5 : 0.75, -0.25);
  } else if (s >= CUE.press && s < CUE.result && sixteenth === 2) hat(s, false, 0.5, 0.2);
}
for (let s = 0; s < SONG_END; s += BEAT / 2) {
  if (!full(s)) continue;
  const { root } = chordAt(s);
  bassNote(s, root + (Math.round(s / (BEAT / 2)) % 2 ? 12 : 0), BEAT / 2);
}
pad(0, SONG_END, (s) => {
  if (s < CUE.result) return 400 + 1800 * (s / CUE.result) ** 2;
  if (s >= CUE.lockup) return 3200;
  return 2600;
}, 1);
for (let s = CUE.result; s < CUE.lockup; s += BEAT / 4) {
  const { notes } = chordAt(s);
  const i = Math.round(s / (BEAT / 4));
  pluck(s, notes[[0, 1, 2, 3, 2, 1, 3, 2][i % 8]] + 12, 0.1, 3200, i % 2 ? 0.35 : -0.35);
}
// Chip lead: an original two-bar hook in the flip and the fan.
const HOOK: [number, number, number][] = [
  [0, 4, 0.5], [0.5, 2, 0.5], [1, 4, 0.5], [1.5, 5, 0.5], [2, 7, 1], [3, 5, 0.5], [3.5, 4, 0.5],
  [4, 2, 0.5], [4.5, 4, 0.5], [5, 2, 0.5], [5.5, 0, 0.5], [6, 1, 1.5],
];
const SCALE = [74, 76, 78, 79, 81, 83, 85, 86]; // D major
for (let base = CUE.presses[0]; base < CUE.lockup - 0.01; base += BAR * 2) {
  for (const [b, step, len] of HOOK) {
    const s = base + b * BEAT;
    if (s >= CUE.lockup) break;
    chip(s, SCALE[step], len * BEAT * 0.9, 0.06, -0.15);
  }
}

// ---------- cue sounds ----------
whoosh(-PREROLL, PREROLL + 0.05, 0.8);
whoosh(CUE.arrive, 1.1, 0.9);
tick(CUE.press, 0.7, 1.4);
pop(CUE.press, 0.7, 1.2);
whoosh(CUE.word - 0.1, 0.9, 0.7, false);
spoken(CUE.word, SPOKEN);
pop(CUE.release, 1.2, 1.0);
riser(CUE.search, CUE.result, 0.8);
for (let s = CUE.search; s < CUE.result - 0.1; s += 0.25) tick(s, 1.1, 0.35);
impact(CUE.result, 0.9);
subDrop(CUE.result, 0.8);
whoosh(CUE.lift, 0.6, 1.0);
sparkle(CUE.lift + 0.1, 96, 1.2);
buzzer(CUE.notOwned, 0.18);
pop(CUE.price, 1.1, 1.1);
tick(CUE.price + 0.02, 1.4, 0.8);
CUE.presses.forEach((s) => { tick(s, 0.6, 1.6, 0.4); checkBlip(s + 0.02, 0.7); whoosh(s, 0.35, 0.6); });
checkBlip(CUE.presses[0] + 0.2, 0.25);
impact(CUE.owned, 0.6);
[0, 0.06, 0.12, 0.2].forEach((d, i) => sparkle(CUE.owned + d, 93 + i * 3, 1.3, (i - 1.5) / 2));
ding(CUE.owned + 0.05, 93, 1.0);
impact(CUE.fan, 0.7);
for (let i = 0; i < 9; i++) pluck(CUE.fan + 0.1 + Math.abs(i - 4) * CUE.fanStep, CHORDS[0].notes[i % 4] + 12, 0.1, 4500, (i - 4) / 5);
sparkle(CUE.fanOwned + 0.1, 98, 1.2);
checkBlip(CUE.fanOwned, 1.0);
for (let i = 0; i < 9; i++) tick(CUE.fanLine + i * 0.06, 1 + i * 0.05, 0.6, (i - 4) / 5);
// On the go.
whoosh(CUE.unplug, 0.4, 1.2, false);
tick(CUE.unplug + 0.02, 0.5, 1.6);
whoosh(CUE.bank - 0.1, 0.45, 0.8);
subDrop(CUE.bank + 0.35, 0.4);
tick(CUE.plugIn, 0.8, 1.6);
checkBlip(CUE.plugIn + 0.05, 0.8);
CUE.rings.forEach((t, i) => sparkle(t, 88 + i * 2, 0.9, 0.3));
checkBlip(CUE.atPhone, 0.6);
riser(CUE.launch - 0.2, CUE.gate, 0.9);
whoosh(CUE.launch, 0.7, 1.1);
tick(CUE.gate, 0.6, 1.8);
checkBlip(CUE.gate + 0.04, 1.2);
impact(CUE.gate, 0.4);
whoosh(CUE.gate, 0.6, 0.9, false);
impact(CUE.atMac, 0.6);
ding(CUE.atMac + 0.05, 91, 0.9);
CUE.chips.forEach((t, i) => pop(t, 0.9 + i * 0.12, 1.0, (i - 1.5) / 2));
riser(CUE.reply - 0.3, CUE.reply + 0.2, 0.5);
whoosh(CUE.reply, 1.0, 1.3);
impact(CUE.backOnBoard, 0.8);
[0, 0.06, 0.12].forEach((d, i) => sparkle(CUE.backOnBoard + d, 93 + i * 3, 1.1));
riser(CUE.lockup - 0.6, CUE.lockup, 0.4);
impact(CUE.lockup, 0.8);
subDrop(CUE.lockup, 0.7);
ding(CUE.lockup + 0.05, 98, 1.1);
pop(CUE.lockTag, 1);
pop(CUE.lockVault, 1.15);
pop(CUE.lockUrl, 1.3);
for (const n of CHORDS[0].notes) pluck(CUE.finalHit, n + 12, 0.2, 5000, 0);
chip(CUE.finalHit, 86, 0.25, 0.07);
chip(CUE.finalHit + 0.25, 90, 0.25, 0.07);
chip(CUE.finalHit + 0.5, 93, 0.8, 0.07);
bassNote(CUE.finalHit, 38, 1.2);

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

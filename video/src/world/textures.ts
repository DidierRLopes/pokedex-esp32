// Canvas-drawn textures. The device screen is a rebuild of the firmware's
// layout (main/pokemon_lookup.c create_ui), drawn at 2x its 368x448 panel.
// Card faces are generic and original: no official artwork.
import * as THREE from "three";
import { C, SANS } from "../theme.ts";
import { CUE } from "../cues.ts";
import { RESULTS, price, type Result } from "../data.ts";
import { clamp, hash, outBack, outCubic, prog } from "../anim.ts";

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const tex = (c: HTMLCanvasElement, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
const rrect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};

// ---------- card faces ----------
export const CARD_W = 512, CARD_H = 716;
const faceCache = new Map<string, HTMLCanvasElement>();
export function cardFace(r: Result): HTMLCanvasElement {
  const hit = faceCache.get(r.id);
  if (hit) return hit;
  const c = canvas(CARD_W, CARD_H);
  const g = c.getContext("2d")!;
  const seed = r.id.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const dark = r.name.startsWith("Dark");
  // Yellow border, silver inner frame.
  const border = g.createLinearGradient(0, 0, CARD_W, CARD_H);
  border.addColorStop(0, "#f7dc4a");
  border.addColorStop(0.5, "#e9c22c");
  border.addColorStop(1, "#f5d846");
  g.fillStyle = border;
  rrect(g, 0, 0, CARD_W, CARD_H, 26);
  g.fill();
  const body = g.createLinearGradient(0, 0, 0, CARD_H);
  body.addColorStop(0, dark ? "#4b3f63" : "#b9a3d9");
  body.addColorStop(1, dark ? "#2a2238" : "#8c72b8");
  g.fillStyle = body;
  rrect(g, 22, 22, CARD_W - 44, CARD_H - 44, 10);
  g.fill();
  // Name + type orb.
  g.fillStyle = "#15102a";
  g.font = `800 40px ${SANS}`;
  g.textBaseline = "middle";
  g.fillText(r.name, 44, 58);
  const orb = g.createRadialGradient(CARD_W - 66, 52, 2, CARD_W - 62, 58, 22);
  orb.addColorStop(0, "#f2d7ff");
  orb.addColorStop(1, "#7b3fc4");
  g.fillStyle = orb;
  g.beginPath();
  g.arc(CARD_W - 62, 58, 20, 0, Math.PI * 2);
  g.fill();
  // Art window: a ghostly nebula (abstract, no character art).
  const ax = 48, ay = 88, aw = CARD_W - 96, ah = 330;
  g.save();
  rrect(g, ax, ay, aw, ah, 6);
  g.clip();
  g.fillStyle = dark ? "#120b1f" : "#231542";
  g.fillRect(ax, ay, aw, ah);
  for (let i = 0; i < 9; i++) {
    const x = ax + hash(seed, i) * aw, y = ay + hash(seed, i + 20) * ah, rad = 60 + hash(seed, i + 40) * 140;
    const n = g.createRadialGradient(x, y, 0, x, y, rad);
    const hue = 265 + hash(seed, i + 60) * 60;
    n.addColorStop(0, `hsla(${hue}, 80%, ${dark ? 45 : 62}%, 0.55)`);
    n.addColorStop(1, `hsla(${hue}, 80%, 30%, 0)`);
    g.fillStyle = n;
    g.fillRect(ax, ay, aw, ah);
  }
  g.strokeStyle = "rgba(240,220,255,0.35)";
  for (let i = 0; i < 5; i++) {
    g.lineWidth = 2 + hash(seed, i + 80) * 3;
    g.beginPath();
    const cx = ax + aw / 2 + (hash(seed, i + 90) - 0.5) * 80, cy = ay + ah / 2 + (hash(seed, i + 95) - 0.5) * 60;
    g.arc(cx, cy, 40 + i * 26, hash(seed, i) * 6, hash(seed, i) * 6 + 2.2 + i * 0.3);
    g.stroke();
  }
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(255,255,255,${0.3 + hash(seed, i + 200) * 0.7})`;
    g.fillRect(ax + hash(seed, i + 300) * aw, ay + hash(seed, i + 400) * ah, 2, 2);
  }
  g.restore();
  g.strokeStyle = "#d8d8e6";
  g.lineWidth = 6;
  rrect(g, ax, ay, aw, ah, 6);
  g.stroke();
  // Attack text as abstract bars (not readable copy).
  g.fillStyle = "rgba(20,12,40,0.55)";
  for (let i = 0; i < 4; i++) {
    const y = 460 + i * 42;
    rrect(g, 58, y, 60 + hash(seed, i + 500) * 60, 16, 8);
    g.fill();
    rrect(g, 140, y, 170 + hash(seed, i + 520) * 150, 16, 8);
    g.fill();
  }
  // Number / set footer.
  g.fillStyle = "#1a1230";
  g.font = `700 22px ${SANS}`;
  g.textAlign = "right";
  g.fillText(`${r.number}/${r.total}`, CARD_W - 44, CARD_H - 48);
  g.textAlign = "left";
  g.font = `600 20px ${SANS}`;
  g.fillText(r.set, 44, CARD_H - 48);
  faceCache.set(r.id, c);
  return c;
}

let faceTexCache: Map<string, THREE.CanvasTexture> | null = null;
export function cardFaceTex(r: Result) {
  faceTexCache ??= new Map();
  let t = faceTexCache.get(r.id);
  if (!t) {
    t = tex(cardFace(r));
    faceTexCache.set(r.id, t);
  }
  return t;
}

// Holo foil: rainbow bands, scrolled per frame through the texture offset.
let holo: THREE.CanvasTexture | null = null;
export function holoTex() {
  if (holo) return holo;
  const c = canvas(512, 64);
  const g = c.getContext("2d")!;
  for (let x = 0; x < 512; x++) {
    const h = (x / 512) * 720;
    g.fillStyle = `hsl(${h % 360}, 95%, 65%)`;
    g.fillRect(x, 0, 1, 64);
  }
  holo = tex(c);
  holo.wrapS = THREE.RepeatWrapping;
  return holo;
}

// Card back: generic dark navy with a swirl, for the long box.
let back: THREE.CanvasTexture | null = null;
export function cardBackTex() {
  if (back) return back;
  const c = canvas(128, 180);
  const g = c.getContext("2d")!;
  g.fillStyle = "#1b2a6b";
  g.fillRect(0, 0, 128, 180);
  const r = g.createRadialGradient(64, 90, 4, 64, 90, 80);
  r.addColorStop(0, "#5c7cff");
  r.addColorStop(1, "rgba(27,42,107,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 180);
  g.strokeStyle = "#e9c22c";
  g.lineWidth = 8;
  g.strokeRect(4, 4, 120, 172);
  back = tex(c);
  return back;
}

// ---------- the device screen ----------
export const SCR_W = 736, SCR_H = 896; // 2x the 368x448 panel
let screen: { c: HTMLCanvasElement; t: THREE.CanvasTexture } | null = null;
let ball: HTMLImageElement | null = null;
export function loadBall(src: string) {
  if (ball) return Promise.resolve();
  return new Promise<void>((resolve) => {
    ball = new Image();
    ball.onload = () => resolve();
    ball.src = src;
  });
}

// Which result is on screen: the side button (PWR) steps through them.
export const resultIndex = (s: number) => (s >= CUE.outro ? 0 : CUE.presses.filter((p) => s >= p).length);
// Voice level for the listening bars: two syllables, "Gen-gar".
export const voiceLevel = (s: number) =>
  CUE.syllables.reduce((a, t, i) => {
    const d = s - t;
    return a + (d > 0 ? Math.exp(-d / (i ? 0.2 : 0.12)) * Math.min(1, d / 0.03) * (i ? 0.8 : 1) : 0);
  }, 0);

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", weight = 600) {
  g.font = `${weight} ${size * 2}px ${SANS}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "top";
  g.fillText(text, x * 2, y * 2);
}

function hintPanel(g: CanvasRenderingContext2D, text: string) {
  // 340x96 at top-mid y=100, radius 16, 1px violet border (firmware s_hint_panel).
  g.fillStyle = C.panel;
  rrect(g, 28 * 2, 100 * 2, 340 * 2, 96 * 2, 32);
  g.fill();
  g.strokeStyle = C.border;
  g.lineWidth = 2;
  g.stroke();
  const lines = text.split("\n");
  lines.forEach((l, i) => label(g, l, 184, 148 - (lines.length * 17) / 2 + i * 17, 14, C.white, "center", 500));
}

export function screenTex(s: number) {
  if (!screen) {
    const c = canvas(SCR_W, SCR_H);
    screen = { c, t: tex(c) };
  }
  const g = screen.c.getContext("2d")!;
  g.fillStyle = C.bg;
  g.fillRect(0, 0, SCR_W, SCR_H);

  if (s < CUE.press) {
    label(g, "POKEDEX", 14, 10, 24, C.violet, "left", 700);
    hintPanel(g, "Companion ready\nHold the screen and speak");
  } else if (s < CUE.release + 0.15) {
    label(g, "LISTENING...", 14, 10, 24, C.listen, "left", 700);
    hintPanel(g, 'Say a card name\ne.g. "Charizard base"\nRelease to search');
    // Live level bars (drawn for the film; the firmware shows the panel only).
    // Room tone keeps the bars breathing between syllables.
    const lv = Math.max(voiceLevel(s), 0.1 + 0.05 * Math.sin(s * 11) + 0.03 * Math.sin(s * 23));
    for (let i = 0; i < 23; i++) {
      const x = 22 + i * 14.5;
      const env = Math.sin((i / 22) * Math.PI) ** 0.7;
      const h = 8 + 150 * lv * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + s * 23)));
      g.fillStyle = C.listen;
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, lv * 1.5);
      rrect(g, x * 2, (330 - h / 2) * 2, 18, h * 2, 9);
      g.fill();
    }
    g.globalAlpha = 1;
    // Touch ripple where the finger lands.
    const d = s - CUE.press;
    if (d < 0.8) {
      g.strokeStyle = `rgba(251,113,133,${1 - d / 0.8})`;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(184 * 2, 330 * 2, 40 + d * 500, 0, Math.PI * 2);
      g.stroke();
    }
  } else if (s < CUE.toDevice + 0.45) {
    // apply_waiting_ui: title is the transcript once known, spinning Poké Ball, ANALYZING...
    const known = s >= CUE.pull;
    label(g, known ? "Gengar" : "SEARCHING...", 14, 10, 24, C.amber, "left", 700);
    if (ball) {
      g.save();
      g.translate((184 - 28) * 2, (120 + 64) * 2);
      g.rotate(s * 6.3);
      g.drawImage(ball, -128, -128, 256, 256);
      g.restore();
    }
    label(g, "ANALYZING...", 184 - 28, 262, 18, C.amber, "center", 600);
  } else {
    // apply_showing_ui
    const i = resultIndex(s);
    const r = RESULTS[i];
    const flipIn = i > 0 && s < CUE.outro ? prog(s, CUE.presses[i - 1], CUE.presses[i - 1] + 0.2) : 1;
    label(g, "Gengar", 14, 10, 24, C.violet, "left", 700);
    label(g, `${i + 1}/${RESULTS.length}`, 354, 14, 18, C.muted, "right", 600);
    // 194x272 card at top-mid, y=44; the first card streams in row by row.
    const rows = i === 0 ? prog(s, CUE.rows[0], CUE.rows[1]) : 1;
    const face = cardFace(r);
    const sh = Math.floor(272 * rows);
    if (flipIn < 1) {
      // The side button swipes the previous printing out to the left.
      const e = outCubic(flipIn);
      g.save();
      g.beginPath();
      g.rect(0, 40 * 2, SCR_W, 280 * 2);
      g.clip();
      g.drawImage(cardFace(RESULTS[i - 1]), (87 - 260 * e) * 2, 44 * 2, 194 * 2, 272 * 2);
      g.drawImage(face, (87 + 260 * (1 - e)) * 2, 44 * 2, 194 * 2, 272 * 2);
      g.restore();
    } else if (sh > 0) {
      g.drawImage(face, 0, 0, CARD_W, (CARD_H * sh) / 272, 87 * 2, 44 * 2, 194 * 2, sh * 2);
    }
    if (rows < 1) {
      g.fillStyle = "rgba(255,255,255,0.9)";
      g.fillRect(87 * 2, (44 + sh) * 2, 194 * 2, 3);
    }
    const [lName, lOwned, lSet, lPrice] = CUE.labels;
    const show = (t: number) => (i > 0 ? 1 : clamp((s - t) / 0.12));
    if (show(lName) > 0) {
      g.globalAlpha = show(lName);
      const mark = r.owned ? "✓" : "✗";
      const text = `#${r.number} ${r.name}`;
      g.font = `700 48px ${SANS}`;
      const tw = g.measureText(text + " ").width;
      const mw = g.measureText(mark).width;
      const x0 = SCR_W / 2 - (tw + mw) / 2;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillStyle = C.white;
      g.fillText(text, x0, 322 * 2);
      if (show(lOwned) > 0) {
        const k = i > 0 ? 1 : outBack(prog(s, lOwned, lOwned + 0.25), 3);
        g.save();
        g.translate(x0 + tw + mw / 2, 322 * 2 + 24);
        g.scale(k, k);
        g.fillStyle = r.owned ? C.owned : C.listen;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(mark, 0, 0);
        g.restore();
      }
      g.globalAlpha = 1;
    }
    if (show(lSet) > 0) {
      g.globalAlpha = show(lSet);
      label(g, `${r.set} (${r.total})`, 184 - 28, 358, 18, C.muted, "center", 600);
      g.globalAlpha = 1;
    }
    if (show(lPrice) > 0) {
      const k = i > 0 ? 1 : outBack(prog(s, lPrice, lPrice + 0.2), 2.5);
      g.save();
      g.translate((184 - 28) * 2, (396 + 12) * 2);
      g.scale(k, k);
      g.font = `700 48px ${SANS}`;
      g.fillStyle = C.amber;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(price(r.price), 0, 0);
      g.restore();
    }
  }
  screen.t.needsUpdate = true;
  return screen.t;
}

// ---------- split-flap characters ----------
const flapCache = new Map<string, THREE.CanvasTexture>();
// Half of a flap: `top` shows the upper half of the glyph.
export function flapTex(ch: string, top: boolean, tint: "white" | "red" | "green") {
  const key = `${ch}${top}${tint}`;
  const hit = flapCache.get(key);
  if (hit) return hit;
  const c = canvas(256, 192);
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, 192);
  bg.addColorStop(0, top ? "#23252e" : "#1a1c23");
  bg.addColorStop(1, top ? "#1a1c23" : "#131419");
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 192);
  g.font = `800 330px ${SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = tint === "red" ? "#ff6b7d" : tint === "green" ? "#5ff0b0" : "#f3f1ea";
  g.fillText(ch, 128, top ? 192 + 14 : 14);
  // Hinge shadow at the split.
  const sh = g.createLinearGradient(0, top ? 192 : 0, 0, top ? 170 : 22);
  sh.addColorStop(0, "rgba(0,0,0,0.6)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = sh;
  g.fillRect(0, top ? 170 : 0, 256, 22);
  const t = tex(c);
  flapCache.set(key, t);
  return t;
}

// ---------- the play mat ----------
let mat: THREE.CanvasTexture | null = null;
export function matTex() {
  if (mat) return mat;
  const c = canvas(2048, 2048);
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(1024, 1024, 100, 1024, 1024, 1400);
  r.addColorStop(0, "#1a1f44");
  r.addColorStop(1, "#090b1c");
  g.fillStyle = r;
  g.fillRect(0, 0, 2048, 2048);
  // Faint Poké Ball line art printed on the mat, like a tournament play mat.
  g.strokeStyle = "rgba(167,139,250,0.10)";
  g.lineWidth = 10;
  g.beginPath();
  g.arc(1024, 1024, 620, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(404, 1024);
  g.lineTo(870, 1024);
  g.moveTo(1178, 1024);
  g.lineTo(1644, 1024);
  g.stroke();
  g.beginPath();
  g.arc(1024, 1024, 154, 0, Math.PI * 2);
  g.stroke();
  // Fabric weave noise.
  const img = g.getImageData(0, 0, 2048, 2048);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (hash(i, 3) - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  mat = tex(c);
  return mat;
}

// Cardboard for the long box.
let board: THREE.CanvasTexture | null = null;
export function cardboardTex() {
  if (board) return board;
  const c = canvas(512, 512);
  const g = c.getContext("2d")!;
  g.fillStyle = "#b39263";
  g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 6) {
    g.fillStyle = `rgba(80,55,25,${0.05 + hash(y, 9) * 0.06})`;
    g.fillRect(0, y, 512, 2);
  }
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (hash(i, 7) - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  board = tex(c);
  board.wrapS = board.wrapT = THREE.RepeatWrapping;
  return board;
}

// Set divider tab label.
const tabCache = new Map<string, THREE.CanvasTexture>();
export function tabTex(text: string) {
  const hit = tabCache.get(text);
  if (hit) return hit;
  const c = canvas(512, 128);
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4efe4";
  rrect(g, 0, 0, 512, 128, 18);
  g.fill();
  g.fillStyle = "#2a2340";
  g.font = `800 60px ${SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  let size = 60;
  while (g.measureText(text).width > 470 && size > 28) {
    size -= 2;
    g.font = `800 ${size}px ${SANS}`;
  }
  g.fillText(text, 256, 68);
  const t = tex(c);
  tabCache.set(text, t);
  return t;
}

// What was actually said, ghosted above the clock one letter per flap.
const ghostCache = new Map<string, THREE.CanvasTexture>();
export function ghostTex(ch: string) {
  const hit = ghostCache.get(ch);
  if (hit) return hit;
  const c = canvas(256, 256);
  const g = c.getContext("2d")!;
  g.font = `800 200px ${SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = C.amber;
  g.shadowBlur = 30;
  g.fillStyle = C.amber;
  g.fillText(ch, 128, 140);
  const t = tex(c);
  ghostCache.set(ch, t);
  return t;
}

// A pill label floating over one of the three clips the new method missed.
const missCache = new Map<string, THREE.CanvasTexture>();
export function missTex(text: string) {
  const hit = missCache.get(text);
  if (hit) return hit;
  const c = canvas(640, 128);
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(12,10,24,0.88)";
  rrect(g, 6, 6, 628, 116, 58);
  g.fill();
  g.strokeStyle = C.listen;
  g.lineWidth = 6;
  g.stroke();
  g.fillStyle = C.white;
  g.font = `700 54px ${SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 320, 68);
  const t = tex(c);
  missCache.set(text, t);
  return t;
}

// Soft round sprite for bokeh and glints.
let soft: THREE.CanvasTexture | null = null;
export function softTex() {
  if (soft) return soft;
  const c = canvas(128, 128);
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  soft = tex(c);
  return soft;
}

// Bokeh disc with a bright rim, like an out-of-focus hall light.
let disc: THREE.CanvasTexture | null = null;
export function discTex() {
  if (disc) return disc;
  const c = canvas(128, 128);
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 62);
  r.addColorStop(0, "rgba(255,255,255,0.35)");
  r.addColorStop(0.85, "rgba(255,255,255,0.5)");
  r.addColorStop(0.95, "rgba(255,255,255,0.9)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  disc = tex(c);
  return disc;
}


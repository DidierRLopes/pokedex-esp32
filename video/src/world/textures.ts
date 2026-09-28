// Canvas textures. The board's screen shows only captures taken from the real
// board (public/screens, via host/capture_screens.py). The one thing animated
// here is what the firmware animates itself: the Poké Ball spinner turns 0.6°
// every 33 ms (ball_spin_timer in main/pokemon_lookup.c).
import * as THREE from "three";
import { C, SANS } from "../theme.ts";
import { CUE, resultAt } from "../cues.ts";
import { SCREENS } from "../data.ts";
import { images } from "../useReady.ts";
import { hash } from "../anim.ts";

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const tex = (c: HTMLCanvasElement | HTMLImageElement) => {
  const t = c instanceof HTMLCanvasElement ? new THREE.CanvasTexture(c) : new THREE.Texture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
};
const rrect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};

// ---------- the board's screen ----------
const SW = 736, SH = 896; // 2x the 368x448 panel
const BALL = { x: 156, y: 184, r: 66 }; // spinner centre and footprint, panel px
let screen: { c: HTMLCanvasElement; t: THREE.CanvasTexture; key: string } | null = null;

export function screenTex(s: number) {
  if (!screen) {
    const c = canvas(SW, SH);
    screen = { c, t: tex(c) as THREE.CanvasTexture, key: "" };
  }
  const spinning = s >= CUE.search && s < CUE.result;
  const path = s < CUE.press ? SCREENS.idle : s < CUE.search ? SCREENS.listening : s < CUE.result ? SCREENS.searching : SCREENS.results[resultAt(s)];
  const key = spinning ? `${path}@${Math.floor((s - CUE.search) * 30)}` : path;
  if (key === screen.key) return screen.t;
  screen.key = key;
  const g = screen.c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(images.get(path)!, 0, 0, SW, SH);
  if (spinning) {
    g.fillStyle = "#080818";
    g.beginPath();
    g.arc(BALL.x * 2, BALL.y * 2, BALL.r * 2, 0, Math.PI * 2);
    g.fill();
    const ticks = Math.floor((s - CUE.search) / 0.033);
    g.save();
    g.translate(BALL.x * 2, BALL.y * 2);
    g.rotate((ticks * 0.6 * Math.PI) / 180);
    g.drawImage(images.get("pokeball.png")!, -128, -128, 256, 256);
    g.restore();
  }
  screen.t.needsUpdate = true;
  return screen.t;
}

// ---------- card art ----------
const artCache = new Map<string, THREE.Texture>();
export function artTex(path: string) {
  let t = artCache.get(path);
  if (!t) {
    // Round the corners like a real card.
    const img = images.get(path)!;
    const c = canvas(img.width, img.height);
    const g = c.getContext("2d")!;
    rrect(g, 0, 0, img.width, img.height, img.width * 0.045);
    g.clip();
    g.drawImage(img, 0, 0);
    t = tex(c);
    artCache.set(path, t);
  }
  return t;
}

// ---------- labels that float in the world ----------
const labelCache = new Map<string, THREE.CanvasTexture>();
// A pill: optional round badge (✓ / ✗) then text.
export function pillTex(text: string, color: string, mark?: "✓" | "✗", big = false) {
  const key = `${text}|${color}|${mark}|${big}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const h = big ? 150 : 110, font = big ? 64 : 48;
  const probe = canvas(10, 10).getContext("2d")!;
  probe.font = `700 ${font}px ${SANS}`;
  const tw = probe.measureText(text).width;
  const badge = mark ? h - 28 : 0;
  const w = Math.ceil(tw + badge + (mark ? 40 : 0) + 80);
  const c = canvas(w, h);
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(10,10,22,0.9)";
  rrect(g, 4, 4, w - 8, h - 8, (h - 8) / 2);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.stroke();
  let x = 40;
  if (mark) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(14 + badge / 2 + 8, h / 2, badge / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#0a0a16";
    g.font = `900 ${Math.round(badge * 0.62)}px ${SANS}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(mark, 22 + badge / 2, h / 2 + 3);
    x = badge + 50;
  }
  g.fillStyle = C.white;
  g.font = `700 ${font}px ${SANS}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x, h / 2 + 3);
  const t = tex(c) as THREE.CanvasTexture;
  labelCache.set(key, t);
  return t;
}
export const pillAspect = (t: THREE.Texture) => (t.image as HTMLCanvasElement).width / (t.image as HTMLCanvasElement).height;

// ---------- the table ----------
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
  const img = g.getImageData(0, 0, 2048, 2048);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (hash(i, 3) - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  mat = tex(c) as THREE.CanvasTexture;
  return mat;
}

// Soft round sprite for glints and sparks.
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
  soft = tex(c) as THREE.CanvasTexture;
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
  disc = tex(c) as THREE.CanvasTexture;
  return disc;
}

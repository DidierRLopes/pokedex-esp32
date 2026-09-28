import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

// The firmware's UI font is LVGL's Montserrat, so the device screen and the
// type layers share it.
export const fontsReady = Promise.all([
  loadMontserrat("normal", { weights: ["500", "600", "700", "800", "900"], subsets: ["latin"] }).waitUntilDone(),
  loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).waitUntilDone(),
]).then(() => document.fonts.ready);

// Palette from main/pokemon_lookup.c (create_ui and the apply_*_ui states).
export const C = {
  bg: "#080b18", // screen background
  panel: "#171a2d", // hint panel / keys
  border: "#6f5bd3",
  violet: "#a78bfa", // title
  lilac: "#d9c6ff",
  listen: "#fb7185", // LISTENING... / ✗
  amber: "#fbbf24", // transcript, price
  owned: "#34d399", // ✓
  muted: "#8b93b5",
  white: "#ffffff",
  // World.
  mat: "#10132a",
  cardboard: "#b89868",
  holoGold: "#f2d13c",
};

export const SANS = "Montserrat, system-ui, sans-serif";
export const MONO = "'JetBrains Mono', Menlo, monospace";
export const W = 1920;
export const H = 1080;

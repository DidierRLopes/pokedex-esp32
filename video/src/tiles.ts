// The proof mosaic's schedule: 224 clips (56 names x 4 voices) laid out 28x8,
// when each tile lands and when it flips. Shared by the world and the score.
import { CUE } from "./cues.ts";
import { hash } from "./anim.ts";

export const COLS = 28, ROWS = 8, VOICES = 4;
export const TILE_COUNT = 224;
export const tileCell = (k: number) => {
  const name = Math.floor(k / VOICES), voice = k % VOICES;
  return { name, voice, col: name % COLS, row: Math.floor(name / COLS) * VOICES + voice };
};
export const tileLand = (k: number) => {
  const { col, row } = tileCell(k);
  const [a, b] = CUE.tiles;
  return a + ((col + row * 1.7) / (COLS + ROWS * 1.7)) * (b - a - 0.3) + hash(k, 5) * 0.12;
};
export const oldWave = (col: number) => CUE.oldPass + (col / (COLS - 1)) * 0.3;
export const newWave = (col: number) => CUE.newWave[0] + (col / (COLS - 1)) * (CUE.newWave[1] - CUE.newWave[0]);

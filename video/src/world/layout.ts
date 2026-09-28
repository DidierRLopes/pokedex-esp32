// Where everything sits on the tabletop. Units are roughly centimetres.
import * as THREE from "three";
import { NAMES } from "../data.ts";

// The board stands on a little easel, leaning back.
export const DEVICE = {
  pos: new THREE.Vector3(4, 2.95, 0),
  tilt: -0.2, // radians about x
  body: [4.4, 5.2, 0.45] as const,
  screen: [3.68, 4.48] as const, // 368x448 panel, 1 unit = 100 px
};
export const deviceMatrix = new THREE.Matrix4().compose(
  DEVICE.pos,
  new THREE.Quaternion().setFromEuler(new THREE.Euler(DEVICE.tilt, 0, 0)),
  new THREE.Vector3(1, 1, 1),
);
// Point on the screen's surface from panel pixels (0..368, 0..448).
export const screenPoint = (px: number, py: number, lift = 0.01) =>
  new THREE.Vector3(px / 100 - 1.84, 2.24 - py / 100, DEVICE.body[2] / 2 + lift).applyMatrix4(deviceMatrix);

// The split-flap clock behind and to the left of the board.
export const CLOCK = { pos: new THREE.Vector3(-5, 1.25, -7), module: 1.15 };
export const clockSlot = (i: number) => CLOCK.pos.clone().add(new THREE.Vector3((i - 2.5) * CLOCK.module, 0, 0.32));

// The long box: one card per distinct name, in alphabetical order.
export const BOX = { x0: -37, z: 3, pitch: 0.04, height: 3.0, width: 3.0 };
export const BOX_LEN = NAMES.length * BOX.pitch + 1.2;
export const CARD = { w: 2.5, h: 3.5, t: 0.018 };
export const cardX = (i: number) => BOX.x0 + 0.6 + i * BOX.pitch;
export const CARD_Y = 0.12 + CARD.h / 2;

// The proof mosaic: 224 clips, 28 columns x 8 rows, in front of the board.
export const GRID = { cx: 4, cz: 12.5, cols: 28, rows: 8, pitch: 0.92 };
export const tileXZ = (col: number, row: number) =>
  [GRID.cx + (col - (GRID.cols - 1) / 2) * GRID.pitch, GRID.cz + (row - (GRID.rows - 1) / 2) * GRID.pitch] as const;

export const BALL = { r: 0.9, z: 1.4, to: 8.4 }; // rolls in from the right

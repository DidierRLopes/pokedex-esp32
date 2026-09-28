// Where everything sits. Units are centimetres, so the board and the cards
// keep their real sizes relative to each other.
import * as THREE from "three";

// Waveshare ESP32-S3-Touch-AMOLED-1.8, from the official dimension drawing:
// case 37.6 x 45.2 x 15 mm; display 28.7 x 34.94 mm (368 x 448 px), sitting
// 3.6 mm from the top edge and 5.7 mm from the bottom; BOOT, USB-C and PWR
// down the right side.
export const BOARD = {
  w: 3.76, h: 4.52, d: 1.5, r: 0.72,
  screen: { w: 2.87, h: 3.494, y: 0.105, r: 0.22 },
  side: { boot: 1.04, usb: 0, pwr: -1.04 }, // y on the right face
};
export const BOARD_POS = new THREE.Vector3(0, 3.2, 0);

// A Pokémon card is 63 x 88 mm; the scans are 600 x 825.
export const CARD = { w: 6.3, h: 6.3 * (825 / 600) };

// The card lifted off the screen floats to the board's left.
export const LIFT = { pos: new THREE.Vector3(-6.2, 4.4, -0.8), rotY: 0.32 };

// Every printing fans out in an arc behind the board.
export const FAN = { center: new THREE.Vector3(0, 5.2, -11), radius: 15, spread: 0.95 };
export const fanSlot = (i: number, n: number) => {
  const a = (i / (n - 1) - 0.5) * FAN.spread;
  return {
    pos: new THREE.Vector3(FAN.center.x + Math.sin(a) * FAN.radius, FAN.center.y - Math.abs(a) * 1.2, FAN.center.z + Math.cos(a) * FAN.radius - FAN.radius + 2.5),
    rotY: -a * 0.8,
  };
};

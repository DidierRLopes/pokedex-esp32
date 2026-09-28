// The pulled card's flight, shared by the card itself and the camera that
// chases it: up out of the long box, a spin to face the lens, then a whip
// across the table onto the board's 194x272 card area.
import * as THREE from "three";
import { CUE } from "../cues.ts";
import { WINNER } from "../data.ts";
import { inOutCubic, lerp, outCubic, outExpo, outBack, prog } from "../anim.ts";
import { BOX, CARD, CARD_Y, DEVICE, cardX, screenPoint } from "./layout.ts";

// How far the winner has already risen in the box before it is pulled.
const risenBy = 0.95 + 1.2 * outBack(1, 2.5);

export function heroPose(s: number) {
  const up = outExpo(prog(s, CUE.pull, CUE.pull + 0.45));
  let pos = new THREE.Vector3(cardX(WINNER), lerp(CARD_Y + risenBy, 8.0, up), BOX.z);
  const spin = outCubic(prog(s, CUE.flip, CUE.flip + 0.7));
  let rotY = lerp(Math.PI / 2, -Math.PI * 2, spin);
  let rotX = 0, scale = 1;
  pos.y += Math.sin((s - CUE.flip) * 2.4) * 0.08 * prog(s, CUE.flip, CUE.flip + 0.5);
  // While it waits, a slow showcase turn so the foil catches the light.
  rotY += Math.sin((s - CUE.flip - 0.7) * 1.6) * 0.32 * prog(s, CUE.flip + 0.7, CUE.flip + 1.2) * (1 - prog(s, CUE.toDevice - 0.2, CUE.toDevice));
  if (s >= CUE.toDevice) {
    const t = inOutCubic(prog(s, CUE.toDevice, CUE.toDevice + 0.45));
    const target = screenPoint(87 + 97, 44 + 136, 0.03);
    pos = pos.clone().lerp(target, t);
    pos.y += Math.sin(t * Math.PI) * 2.5;
    rotX = lerp(0, DEVICE.tilt, t);
    scale = lerp(1, 1.94 / CARD.w, t);
  }
  return { pos, rotX, rotY, scale };
}

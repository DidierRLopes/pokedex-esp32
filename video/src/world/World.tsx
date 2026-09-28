// The 3D world: the real board (built to Waveshare's drawing) floating over a
// card-show table, the card it found lifted off its screen, and every
// printing fanned out behind it. Everything is a pure function of song time.
import React, { useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CUE, resultAt } from "../cues.ts";
import { C, H, W } from "../theme.ts";
import { OWNED_INDEX, RESULTS, cardArt, price } from "../data.ts";
import { clamp, hash, hit, inOutCubic, kick, lerp, outBack, outCubic, outExpo, prog } from "../anim.ts";
import { FOV, cameraAt } from "./camera.ts";
import { BOARD, BOARD_POS, CARD, LIFT } from "./layout.ts";
import { artTex, discTex, matTex, pillAspect, pillTex, screenTex, softTex } from "./textures.ts";
import { Post } from "./Post.tsx";

export const World: React.FC<{ s: number; poster?: boolean }> = ({ s, poster = false }) => (
  <ThreeCanvas width={W} height={H} shadows={{ type: THREE.VSMShadowMap }} gl={{ antialias: false, alpha: false, preserveDrawingBuffer: true, toneMapping: THREE.NoToneMapping, powerPreference: "high-performance" }} camera={{ fov: FOV, near: 0.1, far: 400, position: [0, 5, 20] }}>
    <Scene s={s} poster={poster} />
  </ThreeCanvas>
);

const ADD = THREE.AdditiveBlending;

const Scene: React.FC<{ s: number; poster: boolean }> = ({ s, poster }) => {
  const { camera, scene, gl } = useThree();
  const env = useMemo(() => new THREE.PMREMGenerator(gl).fromScene(new RoomEnvironment(), 0.04).texture, [gl]);
  scene.environment = env;
  scene.environmentIntensity = 0.45;
  const bg = useMemo(() => new THREE.Color("#05060d"), []);
  scene.background = bg;
  const fog = useMemo(() => new THREE.Fog("#05060d", 45, 140), []);
  scene.fog = fog;

  const { pos, look } = cameraAt(s, poster);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  const cam = camera as THREE.PerspectiveCamera;
  cam.fov = FOV - kick(s) * 0.4;
  cam.updateProjectionMatrix();

  const flash = hit(s);
  return (
    <>
      <hemisphereLight args={["#c9c4ff", "#0b0c1c", 0.25 + flash * 0.1]} />
      <spotLight position={[-8, 18, 16]} angle={0.5} penumbra={0.8} intensity={900} decay={2} color="#fff0de" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} />
      <directionalLight position={[6, 10, -14]} intensity={3.5} color="#8f7dff" />
      <directionalLight position={[-12, 4, -6]} intensity={1.6} color="#ffb870" />
      <Table />
      <Backdrop s={s} />
      <Board s={s} poster={poster} />
      <Lifted s={s} poster={poster} />
      <Fan s={s} />
      <Sparks s={s} />
      <Post s={s} poster={poster} />
    </>
  );
};

// ---------- table + hall ----------
const Table: React.FC = () => {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: matTex(), color: "#6d6f8c", roughness: 0.95 }), []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -10]} receiveShadow material={mat}>
      <planeGeometry args={[160, 90]} />
    </mesh>
  );
};

const Backdrop: React.FC<{ s: number }> = ({ s }) => {
  const discs = useMemo(() => Array.from({ length: 40 }, (_, i) => ({
    x: -80 + hash(i, 1) * 160, y: 6 + hash(i, 2) * 34, z: -55 - hash(i, 3) * 45,
    r: 2.5 + hash(i, 4) * 5, warm: hash(i, 5) > 0.35, ph: hash(i, 6) * 6,
  })), []);
  const tex = discTex();
  return (
    <>
      {discs.map((d, i) => (
        <sprite key={i} position={[d.x + Math.sin(s * 0.2 + d.ph) * 0.8, d.y, d.z]} scale={[d.r, d.r, 1]}>
          <spriteMaterial map={tex} color={d.warm ? "#ffc27a" : "#9c86ff"} transparent opacity={0.12 + 0.05 * Math.sin(s * 0.7 + d.ph)} depthWrite={false} blending={ADD} fog={false} />
        </sprite>
      ))}
    </>
  );
};

// ---------- the board ----------
function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

// The board's pose: it rises into place, then turns a little with the story.
export function boardPose(s: number) {
  const arrive = outCubic(prog(s, CUE.arrive, CUE.arrive + 1.2));
  const y = lerp(BOARD_POS.y - 2.2, BOARD_POS.y, arrive) + Math.sin(s * 1.1) * 0.05;
  const rotY = lerp(-0.7, 0, arrive) + 0.12 * inOutCubic(prog(s, CUE.presses[0] - 0.8, CUE.presses[0])) * (1 - prog(s, CUE.fan, CUE.fan + 1));
  const rotX = lerp(0.3, -0.04, arrive);
  return { pos: new THREE.Vector3(BOARD_POS.x, y, BOARD_POS.z), rotX, rotY };
}

const Board: React.FC<{ s: number; poster: boolean }> = ({ s, poster }) => {
  const parts = useMemo(() => {
    const bevel = 0.07;
    const body = new THREE.ExtrudeGeometry(roundedRect(BOARD.w - bevel * 2, BOARD.h - bevel * 2, BOARD.r - bevel), {
      depth: BOARD.d - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 24,
    }).translate(0, 0, -(BOARD.d - bevel * 2) / 2);
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: "#0e0e12", roughness: 0.42, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.25 });
    // Front glass: one black pane over the whole face inside the case lip.
    const glass = new THREE.ShapeGeometry(roundedRect(BOARD.w - 0.26, BOARD.h - 0.26, BOARD.r - 0.13), 24);
    const glassMat = new THREE.MeshPhysicalMaterial({ color: "#020203", roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
    const scr = new THREE.ShapeGeometry(roundedRect(BOARD.screen.w, BOARD.screen.h, BOARD.screen.r), 12);
    // Map UVs so the capture fills the display exactly.
    const uv = scr.attributes.uv as THREE.BufferAttribute, p = scr.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / BOARD.screen.w + 0.5, p.getY(i) / BOARD.screen.h + 0.5);
    const screenMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const button = new RoundedBoxGeometry(0.16, 0.56, 0.36, 3, 0.06);
    const buttonMat = new THREE.MeshPhysicalMaterial({ color: "#16161b", roughness: 0.35, clearcoat: 0.6 });
    const port = new RoundedBoxGeometry(0.06, 0.92, 0.36, 3, 0.1);
    const portMat = new THREE.MeshStandardMaterial({ color: "#020202", roughness: 0.8 });
    // USB-C plug and cable leaving the right side: the board talks to the Mac over it.
    const plug = new RoundedBoxGeometry(1.5, 1.05, 0.6, 4, 0.22);
    const plugMat = new THREE.MeshPhysicalMaterial({ color: "#1b1c22", roughness: 0.5, clearcoat: 0.3 });
    const shell = new RoundedBoxGeometry(0.5, 0.84, 0.3, 3, 0.12);
    const shellMat = new THREE.MeshStandardMaterial({ color: "#b9bcc4", metalness: 1, roughness: 0.25 });
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(BOARD.w / 2 + 1.9, 0, 0), new THREE.Vector3(BOARD.w / 2 + 4.5, -0.6, -0.8),
      new THREE.Vector3(BOARD.w / 2 + 6.5, -2.9, -3.5), new THREE.Vector3(BOARD.w / 2 + 8, -3.15, -12), new THREE.Vector3(BOARD.w / 2 + 12, -3.15, -40),
    ]);
    const cable = new THREE.TubeGeometry(curve, 120, 0.17, 12, false);
    return { body, bodyMat, glass, glassMat, scr, screenMat, button, buttonMat, port, portMat, plug, plugMat, shell, shellMat, cable };
  }, []);
  parts.screenMat.map = screenTex(poster ? 99 : s);
  parts.screenMat.needsUpdate = true;
  const { pos, rotX, rotY } = poster ? { pos: BOARD_POS, rotX: -0.04, rotY: 0.12 } : boardPose(s);
  const front = BOARD.d / 2;
  const press = poster ? 0 : CUE.presses.reduce((a, t) => a + (s >= t - 0.06 ? Math.exp(-Math.max(0, s - t) / 0.09) * clamp((s - t + 0.06) / 0.06) : 0), 0);
  const x = BOARD.w / 2;
  return (
    <group position={pos} rotation={[rotX, rotY, 0]}>
      <mesh geometry={parts.body} material={parts.bodyMat} castShadow receiveShadow />
      <mesh geometry={parts.glass} material={parts.glassMat} position={[0, 0, front + 0.002]} />
      <mesh geometry={parts.scr} material={parts.screenMat} position={[0, BOARD.screen.y, front + 0.006]} />
      <TouchRipple s={s} front={front} />
      {/* Right side, top to bottom: BOOT, USB-C, PWR. */}
      <mesh geometry={parts.button} material={parts.buttonMat} position={[x + 0.04, BOARD.side.boot, 0]} castShadow />
      <mesh geometry={parts.port} material={parts.portMat} position={[x + 0.005, BOARD.side.usb, 0]} />
      <mesh geometry={parts.button} material={parts.buttonMat} position={[x + 0.04 - press * 0.09, BOARD.side.pwr, 0]} castShadow />
      <PressRing s={s} at={[x + 0.3, BOARD.side.pwr, 0]} />
      <mesh geometry={parts.shell} material={parts.shellMat} position={[x + 0.3, 0, 0]} />
      <mesh geometry={parts.plug} material={parts.plugMat} position={[x + 1.25, 0, 0]} castShadow />
      <mesh geometry={parts.cable} material={parts.plugMat} castShadow />
    </group>
  );
};

// The finger lands on the glass: a ring spreads from the touch point.
const TouchRipple: React.FC<{ s: number; front: number }> = ({ s, front }) => {
  const d = s - CUE.press;
  if (d < 0 || d > 0.9) return null;
  const k = outCubic(d / 0.9);
  return (
    <mesh position={[0.2, -0.6, front + 0.012]}>
      <ringGeometry args={[0.1 + k * 1.3, 0.16 + k * 1.3, 48]} />
      <meshBasicMaterial color={C.listen} transparent opacity={(1 - k) * 0.9} toneMapped={false} depthWrite={false} />
    </mesh>
  );
};

// A ring pulses off PWR each time it is pressed.
const PressRing: React.FC<{ s: number; at: [number, number, number] }> = ({ s, at }) => (
  <>
    {CUE.presses.map((t) => {
      const d = s - t;
      if (d < 0 || d > 0.6) return null;
      const k = outCubic(d / 0.6);
      return (
        <mesh key={t} position={at} rotation={[0, Math.PI / 2, 0]}>
          <ringGeometry args={[0.3 + k * 1.1, 0.36 + k * 1.1, 40]} />
          <meshBasicMaterial color={C.violet} transparent opacity={(1 - k) * 0.9} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      );
    })}
  </>
);

// ---------- the card lifted off the screen ----------
// A floating label; sized by its texture's aspect.
const Pill: React.FC<{ tex: THREE.Texture; pos: THREE.Vector3 | [number, number, number]; height: number; k: number }> = ({ tex, pos, height, k }) => {
  if (k <= 0) return null;
  return (
    <sprite position={pos} scale={[height * pillAspect(tex) * k, height * k, 1]}>
      <spriteMaterial map={tex} transparent depthTest={false} toneMapped={false} />
    </sprite>
  );
};

const Lifted: React.FC<{ s: number; poster: boolean }> = ({ s, poster }) => {
  const mats = useMemo(() => ({
    face: new THREE.MeshPhysicalMaterial({ roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.2, envMapIntensity: 0.5, transparent: true }),
    leaving: new THREE.MeshPhysicalMaterial({ roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.2, envMapIntensity: 0.5, transparent: true, depthWrite: false }),
  }), []);
  const t = poster ? 99 : s;
  if (!poster && (s < CUE.lift - 0.05 || s >= CUE.fan + 0.9)) return null;
  const i = poster ? OWNED_INDEX : resultAt(s);
  // Each press shuffles printings: the old card slides out left while the
  // new one slides in from the board's side.
  const lastPress = poster ? undefined : [...CUE.presses].reverse().find((p) => s >= p);
  const swap = lastPress !== undefined ? outCubic(prog(s, lastPress, lastPress + 0.35)) : 1;
  mats.face.map = artTex(cardArt(RESULTS[i]));
  mats.face.needsUpdate = true;
  if (swap < 1) {
    mats.leaving.map = artTex(cardArt(RESULTS[i - 1]));
    mats.leaving.needsUpdate = true;
  }
  // Rise from the screen to the board's left, growing to real card size.
  const up = poster ? 1 : outExpo(prog(s, CUE.lift, CUE.lift + 0.7));
  const from = new THREE.Vector3(BOARD_POS.x, BOARD_POS.y + BOARD.screen.y + 0.3, 0.9);
  const pos = from.clone().lerp(LIFT.pos, up);
  pos.y += Math.sin(t * 1.4) * 0.08;
  let scale = lerp((BOARD.screen.w * (194 / 368)) / CARD.w, 1, up);
  let rotY = LIFT.rotY + Math.sin(t * 0.8) * 0.05;
  // At the fan it flies to its slot among the other printings.
  if (!poster && s >= CUE.fan) {
    const f = inOutCubic(prog(s, CUE.fan, CUE.fan + 0.8));
    const slot = fanPose(OWNED_INDEX, s);
    pos.lerp(slot.pos, f);
    scale = lerp(scale, slot.scale, f);
    rotY = lerp(rotY, slot.rotY, f);
  }
  mats.face.opacity = clamp(up * 4) * clamp(swap * 1.6);
  mats.leaving.opacity = 1 - swap;
  // Labels for the printing on screen.
  const r = RESULTS[i];
  const own = r.owned;
  const pop = (a: number) => outBack(prog(t, a, a + 0.3), 2.2);
  const ownK = poster ? 1 : i === 0 ? pop(CUE.notOwned) : pop(lastPress! + 0.2);
  const priceK = poster ? 1 : i === 0 ? pop(CUE.price) : pop(lastPress! + 0.3);
  const fade = poster ? 1 : 1 - prog(s, CUE.fan - 0.2, CUE.fan + 0.1);
  const burst = !poster && own && s >= CUE.owned ? 1 + 0.25 * Math.exp(-(s - CUE.owned) / 0.25) : 1;
  const ownTex = own ? pillTex("In your Pokévault collection", C.owned, "✓", true) : pillTex("Not in your Pokévault collection", C.listen, "✗");
  const priceTex = pillTex(`${price(r.price)} · live price`, C.amber);
  const b = LIFT.pos;
  return (
    <>
      <group position={[pos.x + (1 - swap) * 3.2, pos.y, pos.z]} rotation={[0, rotY - (1 - swap) * 0.35, 0]} scale={scale}>
        <mesh material={mats.face} castShadow>
          <planeGeometry args={[CARD.w, CARD.h]} />
        </mesh>
      </group>
      {swap < 1 && (
        <group position={[pos.x - swap * 3.6, pos.y - swap * 0.3, pos.z - swap * 1.5]} rotation={[0, rotY + swap * 0.5, 0]} scale={scale}>
          <mesh material={mats.leaving}>
            <planeGeometry args={[CARD.w, CARD.h]} />
          </mesh>
        </group>
      )}
      <Pill tex={ownTex} pos={[b.x + 0.6, b.y - CARD.h / 2 + 1.35, b.z + 1.6]} height={(own ? 1.3 : 1.05) * burst} k={ownK * fade} />
      <Pill tex={priceTex} pos={[b.x + 0.6, b.y - CARD.h / 2 + 0.05, b.z + 1.6]} height={1.05} k={priceK * fade} />
    </>
  );
};

// ---------- every printing ----------
// A gentle arc behind the board; the one you own steps forward.
export function fanPose(i: number, s: number) {
  const n = RESULTS.length;
  const x = (i - (n - 1) / 2) * 7.1;
  const own = i === OWNED_INDEX ? outBack(prog(s, CUE.fanOwned, CUE.fanOwned + 0.4), 1.6) : 0;
  return {
    pos: new THREE.Vector3(x, 9.2 + own * 0.6, -12 - (x * x) / 70 + own * 4),
    rotY: -x / 45,
    scale: 1 + own * 0.08,
  };
}

const Fan: React.FC<{ s: number }> = ({ s }) => {
  const mats = useMemo(() => RESULTS.map((r) => new THREE.MeshPhysicalMaterial({ map: artTex(cardArt(r)), roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.2, envMapIntensity: 0.5 })), []);
  if (s < CUE.fan - 0.1) return null;
  const out = prog(s, CUE.lockup, CUE.lockup + 0.8); // labels go; the cards stay, dimmed
  return (
    <>
      {RESULTS.map((r, i) => {
        if (i === OWNED_INDEX && s < CUE.fan + 0.8) return null; // the lifted card is flying there
        const at = CUE.fan + 0.1 + Math.abs(i - (RESULTS.length - 1) / 2) * CUE.fanStep;
        const k = i === OWNED_INDEX ? 1 : outBack(prog(s, at, at + 0.45), 1.5);
        if (k <= 0) return null;
        const slot = fanPose(i, s);
        const rest = fanPose(i, 0); // labels stay put while the owned card steps forward
        // Each card flies out from behind the board.
        const p = new THREE.Vector3(BOARD_POS.x, BOARD_POS.y, -2).lerp(slot.pos, k);
        const labelK = outBack(prog(s, CUE.fanLine + i * 0.06, CUE.fanLine + i * 0.06 + 0.3), 2) * (1 - out);
        const dim = i === OWNED_INDEX || s < CUE.fanOwned ? 1 : 1 - 0.4 * prog(s, CUE.fanOwned, CUE.fanOwned + 0.4);
        mats[i].color.setScalar(dim * (1 - out * 0.55));
        const tex = pillTex(price(r.price), r.owned ? C.owned : C.listen, r.owned ? "✓" : "✗");
        return (
          <group key={r.id}>
            <group position={p} rotation={[0, slot.rotY, 0]} scale={slot.scale * Math.max(0.001, k)}>
              <mesh material={mats[i]} castShadow>
                <planeGeometry args={[CARD.w, CARD.h]} />
              </mesh>
            </group>
            <Pill tex={tex} pos={[rest.pos.x, rest.pos.y - CARD.h / 2 - 1.2, rest.pos.z + 0.5]} height={i === OWNED_INDEX ? 1.9 : 1.6} k={labelK} />
          </group>
        );
      })}
    </>
  );
};

// ---------- sparks when the owned card appears ----------
const Sparks: React.FC<{ s: number }> = ({ s }) => {
  const soft = softTex();
  const bursts = [
    { t: CUE.owned, at: LIFT.pos.clone().add(new THREE.Vector3(0, 0, 0.5)), n: 70, color: C.owned, speed: 6 },
    { t: CUE.fanOwned + 0.1, at: fanPose(OWNED_INDEX, CUE.fanOwned + 1).pos, n: 60, color: C.owned, speed: 6 },
  ];
  const out: React.ReactNode[] = [];
  for (const [bi, b] of bursts.entries()) {
    const d = s - b.t;
    if (d < 0 || d > 1.4) continue;
    for (let i = 0; i < b.n; i++) {
      const th = hash(i, bi + 20) * Math.PI * 2, ph = (hash(i, bi + 40) - 0.3) * Math.PI * 0.7;
      const v = b.speed * (0.4 + hash(i, bi + 60) * 0.6);
      const p = new THREE.Vector3(Math.cos(th) * Math.cos(ph) * v * d, Math.sin(ph) * v * d - 4.9 * d * d, Math.sin(th) * Math.cos(ph) * v * d * 0.4).add(b.at);
      const life = 1 - d / (0.8 + hash(i, bi + 80) * 0.6);
      if (life <= 0) continue;
      const k = 0.35 * life + 0.06;
      out.push(
        <sprite key={`${bi}-${i}`} position={p} scale={[k, k, 1]}>
          <spriteMaterial map={soft} color={new THREE.Color(b.color).multiplyScalar(3)} transparent opacity={life} depthWrite={false} blending={ADD} toneMapped={false} />
        </sprite>,
      );
    }
  }
  return <>{out}</>;
};

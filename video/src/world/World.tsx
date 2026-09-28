// The 3D world: a card-show tabletop with the PokeDex board on its easel, a
// split-flap clock, a long box holding one card per name, and a play mat.
// Everything is a pure function of song time `s`.
import React, { useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CUE, SHORTLIST, SPOKEN, WRONG } from "../cues.ts";
import { C, H, W } from "../theme.ts";
import { BENCH_NAMES, BENCH_VOICES, NAMES, NEW_MISSES, RESULTS, SETS, WINNER } from "../data.ts";
import { clamp, hash, hit, inCubic, inOutCubic, kick, lerp, outBack, outCubic, outExpo, prog, spring } from "../anim.ts";
import { cameraAt, fovAt } from "./camera.ts";
import { BALL, BOX, BOX_LEN, CARD, CARD_Y, CLOCK, DEVICE, GRID, cardX, clockSlot, deviceMatrix, screenPoint, tileXZ } from "./layout.ts";
import { cardBackTex, cardFaceTex, cardboardTex, discTex, flapTex, ghostTex, holoTex, missTex, matTex, screenTex, softTex, tabTex, voiceLevel } from "./textures.ts";
import { Post } from "./Post.tsx";
import { flapState } from "../flaps.ts";
import { heroPose } from "./hero.ts";
import { TILE_COUNT, newWave, oldWave, tileCell, tileLand } from "../tiles.ts";

export const World: React.FC<{ s: number; poster?: boolean }> = ({ s, poster = false }) => (
  <ThreeCanvas width={W} height={H} shadows={{ type: THREE.VSMShadowMap }} gl={{ antialias: false, alpha: false, preserveDrawingBuffer: true, toneMapping: THREE.NoToneMapping, powerPreference: "high-performance" }} camera={{ fov: 30, near: 0.05, far: 400, position: [0, 5, 10] }}>
    <Scene s={s} poster={poster} />
  </ThreeCanvas>
);

const ADD = THREE.AdditiveBlending;
const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

// Emissive that follows each instance's color (for glowing tiles).
function instanceGlow<T extends THREE.MeshStandardMaterial>(mat: T, boost: { value: number }) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.glowBoost = boost;
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "uniform float glowBoost;\nvoid main() {")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\ntotalEmissiveRadiance += vColor * glowBoost;\n#endif");
  };
  return mat;
}

const Scene: React.FC<{ s: number; poster: boolean }> = ({ s, poster }) => {
  const { camera, scene, gl } = useThree();
  const env = useMemo(() => new THREE.PMREMGenerator(gl).fromScene(new RoomEnvironment(), 0.04).texture, [gl]);
  scene.environment = env;
  scene.environmentIntensity = 0.35;
  const bg = useMemo(() => new THREE.Color("#05060d"), []);
  scene.background = bg;
  const fog = useMemo(() => new THREE.Fog("#05060d", 30, 110), []);
  scene.fog = fog;

  const { pos, look } = cameraAt(s, poster);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  const cam = camera as THREE.PerspectiveCamera;
  cam.fov = fovAt(s, poster) - kick(s) * 0.5;
  cam.updateProjectionMatrix();

  const flash = hit(s);
  return (
    <>
      <hemisphereLight args={["#c9c4ff", "#0b0c1c", 0.2 + flash * 0.1]} />
      <spotLight position={[1, 12, 9]} angle={0.42} penumbra={0.7} intensity={260} decay={2} color="#ffe2c2" target-position={[4, 1.5, 1]} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} />
      <directionalLight position={[-6, 7, -12]} intensity={3.2} color="#7e6bff" />
      <directionalLight position={[-14, 22, 16]} intensity={1.7} color="#fff1dc" castShadow shadow-mapSize={[4096, 4096]} shadow-camera-left={-45} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} shadow-camera-far={90} shadow-bias={-0.0004} shadow-radius={5} shadow-blurSamples={12} />
      <directionalLight position={[6, 8, -18]} intensity={1.6} color="#8f7dff" />
      <pointLight position={[4, 3, 2.2]} intensity={6} distance={9} color={C.violet} />
      <Mat />
      <Backdrop s={s} />
      <Device s={s} />
      <VoiceBars s={s} />
      <FlapClock s={s} />
      <LongBox s={s} />
      <HeroCard s={s} />
      <Mosaic s={s} />
      <MissLabels s={s} />
      <PokeBall s={s} />
      <Sparks s={s} />
      <Post s={s} poster={poster} />
    </>
  );
};

// ---------- mat + backdrop ----------
const Mat: React.FC = () => {
  const mat = useMemo(() => {
    const t = matTex();
    return new THREE.MeshStandardMaterial({ map: t, color: "#6d6f8c", roughness: 0.95, metalness: 0 });
  }, []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-8, 0, 4]} receiveShadow material={mat}>
      <planeGeometry args={[110, 70]} />
    </mesh>
  );
};

// Out-of-focus hall lights far behind the table: this is a card show.
const Backdrop: React.FC<{ s: number }> = ({ s }) => {
  const discs = useMemo(() => Array.from({ length: 34 }, (_, i) => ({
    x: -70 + hash(i, 1) * 110, y: 4 + hash(i, 2) * 26, z: -38 - hash(i, 3) * 40,
    r: 1.2 + hash(i, 4) * 2.6, warm: hash(i, 5) > 0.35, ph: hash(i, 6) * 6,
  })), []);
  const tex = discTex();
  return (
    <>
      {discs.map((d, i) => (
        <sprite key={i} position={[d.x + Math.sin(s * 0.2 + d.ph) * 0.8, d.y, d.z]} scale={[d.r, d.r, 1]}>
          <spriteMaterial map={tex} color={d.warm ? "#ffc27a" : "#9c86ff"} transparent opacity={0.11 + 0.05 * Math.sin(s * 0.7 + d.ph)} depthWrite={false} blending={ADD} fog={false} />
        </sprite>
      ))}
    </>
  );
};

// ---------- the board ----------
const Device: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const [bw, bh, bd] = DEVICE.body;
    const body = new RoundedBoxGeometry(bw, bh, bd, 5, 0.2);
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: "#17181f", metalness: 0.55, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: "#020203", metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4 });
    const screenMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const sheen = new THREE.MeshPhysicalMaterial({ color: "#000000", transparent: true, opacity: 0.18, roughness: 0.02, metalness: 1, envMapIntensity: 2.2, depthWrite: false });
    const button = new RoundedBoxGeometry(0.16, 0.62, 0.24, 3, 0.06);
    const buttonMat = new THREE.MeshPhysicalMaterial({ color: "#2a2c35", metalness: 0.8, roughness: 0.25 });
    const stand = new RoundedBoxGeometry(3.2, 0.45, 1.8, 3, 0.12);
    const standMat = new THREE.MeshPhysicalMaterial({ color: "#c9c6ff", transparent: true, opacity: 0.28, roughness: 0.05, clearcoat: 1, metalness: 0 });
    // USB-C cable from the board's bottom edge, over the mat, off into the dark.
    const start = new THREE.Vector3(0, -bh / 2 - 0.05, -0.05).applyMatrix4(deviceMatrix);
    const curve = new THREE.CatmullRomCurve3([
      start, start.clone().add(new THREE.Vector3(0, -0.2, -0.25)), new THREE.Vector3(4.2, 0.16, -1.8),
      new THREE.Vector3(2.5, 0.14, -5), new THREE.Vector3(-3, 0.14, -12), new THREE.Vector3(-12, 0.14, -24),
    ]);
    const cable = new THREE.TubeGeometry(curve, 160, 0.11, 12, false);
    const cableMat = new THREE.MeshStandardMaterial({ color: "#0c0d12", roughness: 0.55, metalness: 0.1 });
    return { body, bodyMat, glassMat, screenMat, sheen, button, buttonMat, stand, standMat, curve, cable, cableMat };
  }, []);
  parts.screenMat.map = screenTex(s);
  parts.screenMat.needsUpdate = true;
  const [bw, , bd] = DEVICE.body;
  // PWR (upper) goes in on each press; BOOT stays.
  const press = CUE.presses.reduce((a, t) => a + (s >= t ? Math.exp(-(s - t) / 0.07) * Math.min(1, (s - t) / 0.02) : 0), 0);
  // Data pulses along the cable: voice upload out, card image in.
  const pulses: { u: number; c: string }[] = [];
  for (let k = 0; k < 6; k++) {
    const up = (s - CUE.release - k * 0.08) / 0.8;
    if (up > 0 && up < 1) pulses.push({ u: up, c: C.listen });
    const dn = (s - CUE.rows[0] + 0.3 - k * 0.1) / 0.7;
    if (dn > 0 && dn < 1) pulses.push({ u: 1 - dn, c: C.amber });
  }
  const glow = softTex();
  return (
    <>
      <group position={DEVICE.pos} rotation={[DEVICE.tilt, 0, 0]}>
        <mesh geometry={parts.body} material={parts.bodyMat} castShadow receiveShadow />
        <mesh position={[0, 0, bd / 2 + 0.002]} material={parts.glassMat}>
          <planeGeometry args={[bw - 0.28, DEVICE.body[1] - 0.28]} />
        </mesh>
        <mesh position={[0, 0, bd / 2 + 0.006]} material={parts.screenMat}>
          <planeGeometry args={[DEVICE.screen[0], DEVICE.screen[1]]} />
        </mesh>
        <mesh position={[0, 0, bd / 2 + 0.01]} material={parts.sheen}>
          <planeGeometry args={[bw - 0.28, DEVICE.body[1] - 0.28]} />
        </mesh>
        <mesh geometry={parts.button} material={parts.buttonMat} position={[bw / 2 + 0.05 - press * 0.07, 1.0, 0]} castShadow />
        <mesh geometry={parts.button} material={parts.buttonMat} position={[bw / 2 + 0.05, 0.05, 0]} castShadow />
      </group>
      <mesh geometry={parts.stand} material={parts.standMat} position={[DEVICE.pos.x, 0.23, 0.2]} castShadow />
      <mesh geometry={parts.cable} material={parts.cableMat} castShadow receiveShadow />
      {pulses.map((p, i) => {
        const at = parts.curve.getPointAt(Math.min(0.999, p.u * 0.55));
        return (
          <sprite key={i} position={[at.x, at.y + 0.02, at.z]} scale={[0.9, 0.9, 1]}>
            <spriteMaterial map={glow} color={p.c} transparent depthWrite={false} blending={ADD} toneMapped={false} />
          </sprite>
        );
      })}
    </>
  );
};

// ---------- the waveform peels off the glass and flies to the clock ----------
const BARS = 23;
const VoiceBars: React.FC<{ s: number }> = ({ s }) => {
  const { mesh, mat } = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.listen).multiplyScalar(2.2), toneMapped: false });
    const mesh = new THREE.InstancedMesh(new RoundedBoxGeometry(0.1, 1, 0.06, 2, 0.03), mat, BARS);
    mesh.frustumCulled = false;
    return { mesh, mat };
  }, []);
  const a = CUE.release, b = CUE.wrong;
  const visible = s >= a && s < b + 0.05;
  mesh.visible = visible;
  if (visible) {
    const lv = Math.max(0.35, voiceLevel(a));
    for (let i = 0; i < BARS; i++) {
      const px = 22 + i * 14.5 + 9 / 2;
      const env = Math.sin((i / 22) * Math.PI) ** 0.7;
      const h0 = (8 + 150 * lv * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + a * 23)))) / 100;
      const from = screenPoint(px, 330, 0.05);
      const slot = clockSlot(Math.floor((i / BARS) * 6));
      const to = slot.clone().add(new THREE.Vector3(((i % 4) - 1.5) * 0.2, 0, 0.1));
      const t = inOutCubic(prog(s, a + i * 0.012, b - 0.1));
      const p = from.clone().lerp(to, t);
      p.y += Math.sin(t * Math.PI) * (2.2 + (i % 5) * 0.25);
      p.z += Math.sin(t * Math.PI) * 1.5;
      dummy.position.copy(p);
      dummy.rotation.set(DEVICE.tilt * (1 - t) + t * i * 0.3, t * (i - 11) * 0.35, 0);
      const peel = outBack(prog(s, a, a + 0.25), 2);
      dummy.scale.set(1, lerp(h0, 0.2, t) * (0.6 + 0.4 * peel), 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mat.opacity = 1;
  }
  return <primitive object={mesh} />;
};

// ---------- the split-flap clock ----------
const FW = 1.02, FH = 0.72;
const FlapClock: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const housing = new RoundedBoxGeometry(CLOCK.module * 6 + 0.6, 2.2, 1.0, 4, 0.14);
    const housingMat = new THREE.MeshPhysicalMaterial({ color: "#1c1d24", metalness: 0.7, roughness: 0.3, clearcoat: 0.5 });
    const top = new THREE.PlaneGeometry(FW, FH).translate(0, FH / 2 + 0.01, 0);
    const bottom = new THREE.PlaneGeometry(FW, FH).translate(0, -FH / 2 - 0.01, 0);
    const flapFront = new THREE.PlaneGeometry(FW, FH).translate(0, FH / 2 + 0.01, 0);
    const flapBack = new THREE.PlaneGeometry(FW, FH).rotateX(Math.PI).translate(0, FH / 2 + 0.01, 0);
    const mats = Array.from({ length: 6 }, () => ({
      top: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      bottom: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      front: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      back: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
    }));
    return { housing, housingMat, top, bottom, flapFront, flapBack, mats };
  }, []);
  const judged = s >= CUE.buzz && s < CUE.rewind;
  const glow = judged ? 0.9 + 0.4 * Math.exp(-(s - CUE.buzz) / 0.2) : 0;
  const said = SPOKEN.toUpperCase();
  const ghost = clamp((s - (CUE.buzz - 0.25)) / 0.25) * (1 - clamp((s - CUE.rewind) / 0.2));
  return (
    <group>
      <mesh geometry={parts.housing} material={parts.housingMat} position={[CLOCK.pos.x, CLOCK.pos.y, CLOCK.pos.z - 0.2]} castShadow receiveShadow />
      {Array.from({ length: 6 }, (_, m) => {
        const { prev, next, p } = flapState(m, s);
        const mm = parts.mats[m];
        // Letters that don't match what was said turn red; N and G survive.
        const tint = judged && WRONG[m] !== said[m] ? "red" : "white";
        mm.top.map = flapTex(next, true, tint);
        mm.bottom.map = flapTex(p >= 0.5 ? next : prev, false, tint);
        mm.front.map = flapTex(prev, true, tint);
        mm.back.map = flapTex(next, false, tint);
        for (const k of ["top", "bottom", "front", "back"] as const) {
          mm[k].emissive.set(tint === "red" ? "#ff3048" : "#000000");
          mm[k].emissiveIntensity = glow * 0.25;
          mm[k].emissiveMap = mm[k].map;
          mm[k].needsUpdate = true;
        }
        const slot = clockSlot(m);
        const angle = -Math.PI * inCubic(Math.min(1, p * 1.05));
        return (
          <group key={m} position={slot}>
            <mesh geometry={parts.top} material={mm.top} />
            <mesh geometry={parts.bottom} material={mm.bottom} />
            {ghost > 0 && (
              <sprite position={[0, 1.55 + (1 - ghost) * 0.3, 0.1]} scale={[1.05, 1.05, 1]}>
                <spriteMaterial map={ghostTex(said[m])} transparent opacity={ghost} depthWrite={false} toneMapped={false} />
              </sprite>
            )}
            {p < 1 && (
              <group rotation={[angle, 0, 0]} position={[0, 0, 0.02]}>
                <mesh geometry={parts.flapFront} material={mm.front} />
                <mesh geometry={parts.flapBack} material={mm.back} />
              </group>
            )}
          </group>
        );
      })}
    </group>
  );
};

// ---------- the long box ----------
// Scores: the winner is 1; the shortlist sits high; everyone else low.
const FINAL_NAMES = ["Gastly", "Gligar", "Jynx"].filter((n) => NAMES.includes(n));
const FINALISTS = FINAL_NAMES.map((n) => NAMES.indexOf(n));
const SHORT = (() => {
  const rest = NAMES.map((_, i) => i).filter((i) => i !== WINNER && !FINALISTS.includes(i));
  rest.sort((a, b) => hash(b, 2) - hash(a, 2));
  return [WINNER, ...FINALISTS, ...rest.slice(0, SHORTLIST - 1 - FINALISTS.length)];
})();
const SHORT_RANK = new Map(SHORT.map((i, r) => [i, r]));
const score = (i: number) => (i === WINNER ? 1 : SHORT_RANK.has(i) ? 0.45 + hash(i, 7) * 0.3 : hash(i, 1) * 0.25);
const scanX = (s: number) => lerp(BOX.x0 - 1, BOX.x0 + BOX_LEN + 1, inOutCubic(prog(s, CUE.scan[0], CUE.scan[1])) );
const passedAt = (i: number) => {
  const u = (cardX(i) - (BOX.x0 - 1)) / (BOX_LEN + 2);
  // invert the inOutCubic roughly by bisection
  let lo = 0, hi = 1;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (inOutCubic(mid) < u) lo = mid; else hi = mid;
  }
  return lerp(CUE.scan[0], CUE.scan[1], lo);
};
const PASSED = NAMES.map((_, i) => passedAt(i));
const DIVIDERS = SETS.map((name, k) => ({ name, i: Math.round(((k + 0.5) / SETS.length) * NAMES.length) }));

const rise = (i: number, s: number) => {
  let y = 0;
  const r = SHORT_RANK.get(i);
  if (r !== undefined) y += 0.95 * outBack(prog(s, CUE.shortlist + (r / SHORTLIST) * 1.4, CUE.shortlist + (r / SHORTLIST) * 1.4 + 0.35), 2.2);
  const f = FINALISTS.indexOf(i);
  if (f >= 0) y += 0.9 * outBack(prog(s, CUE.finalists[f], CUE.finalists[f] + 0.3), 2.5);
  if (i === WINNER) y += 1.2 * outBack(prog(s, CUE.finalists[3], CUE.finalists[3] + 0.3), 2.5);
  return y;
};
export const winnerRise = (s: number) => rise(WINNER, s);

const LongBox: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const board = new THREE.MeshStandardMaterial({ map: cardboardTex(), roughness: 0.85 });
    const back = new THREE.MeshStandardMaterial({ map: cardBackTex(), roughness: 0.45, metalness: 0.05 });
    const edge = new THREE.MeshStandardMaterial({ color: "#efe9d6", roughness: 0.6 });
    const cardGeo = new THREE.BoxGeometry(CARD.t, CARD.h, CARD.w);
    const cards = new THREE.InstancedMesh(cardGeo, [back, back, edge, edge, edge, edge], NAMES.length);
    cards.castShadow = true;
    cards.receiveShadow = true;
    cards.frustumCulled = false;
    const glowMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: ADD, depthWrite: false });
    const glows = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.05, CARD.w * 0.96), glowMat, NAMES.length);
    glows.frustumCulled = false;
    for (let i = 0; i < NAMES.length; i++) glows.setColorAt(i, tmpColor.set(0, 0, 0));
    const tabGeo = new THREE.PlaneGeometry(1.6, 0.4);
    return { board, cards, glows, tabGeo };
  }, []);
  const winnerGone = s >= CUE.pull;
  const sx = scanX(s);
  for (let i = 0; i < NAMES.length; i++) {
    const hide = i === WINNER && winnerGone;
    dummy.position.set(cardX(i), CARD_Y + rise(i, s), BOX.z);
    dummy.rotation.set(0, 0, (hash(i, 9) - 0.5) * 0.03);
    dummy.scale.setScalar(hide ? 0.0001 : 1);
    dummy.updateMatrix();
    parts.cards.setMatrixAt(i, dummy.matrix);
    dummy.position.y += CARD.h / 2 + 0.03;
    dummy.updateMatrix();
    parts.glows.setMatrixAt(i, dummy.matrix);
    // Glow: flare as the voice passes, settle to the card's score.
    const sc = score(i);
    let g = 0;
    if (s >= PASSED[i]) {
      const d = s - PASSED[i];
      g = sc * 0.55 + (0.4 + sc) * Math.exp(-d / 0.18);
    }
    const inShort = SHORT_RANK.has(i);
    if (s >= CUE.shortlist) {
      // Eliminated names go dark one by one as the count narrows.
      const out = CUE.shortlist + hash(i, 3) * 1.3;
      g = inShort ? g * 0.4 + 0.9 : g * (1 - prog(s, out, out + 0.2)) * (s < out ? 1 : 0.3);
    }
    if (hide) g = 0;
    const fin = FINALISTS.includes(i) || i === WINNER;
    const col = fin && s >= CUE.finalists[0] ? C.violet : s >= CUE.shortlist && inShort ? C.amber : C.listen;
    tmpColor.set(col).multiplyScalar(g * 2.2 * (1 + kick(s) * 0.25));
    parts.glows.setColorAt(i, tmpColor);
  }
  parts.cards.instanceMatrix.needsUpdate = true;
  parts.glows.instanceMatrix.needsUpdate = true;
  parts.glows.instanceColor!.needsUpdate = true;

  const len = BOX_LEN, cx = BOX.x0 + len / 2;
  const scanOn = s >= CUE.scan[0] - 0.2 && s < CUE.scan[1] + 0.2;
  // The voice rides above the cards as a waveform comet.
  const dots = [] as React.ReactNode[];
  if (scanOn) {
    const soft = softTex();
    for (let j = 0; j < 90; j++) {
      const x = sx - j * 0.09;
      const env = Math.exp(-j / 40);
      const y = CARD_Y + CARD.h / 2 + 0.9 + Math.sin(j * 0.55 - s * 30) * 0.45 * env * (0.6 + 0.4 * Math.sin(j * 0.13));
      dots.push(
        <sprite key={j} position={[x, y, BOX.z]} scale={[0.35 * env + 0.08, 0.35 * env + 0.08, 1]}>
          <spriteMaterial map={soft} color={new THREE.Color(C.listen).multiplyScalar(2)} transparent opacity={env} depthWrite={false} blending={ADD} toneMapped={false} />
        </sprite>,
      );
    }
  }
  return (
    <group>
      {/* Box: floor, two long walls, two end walls. */}
      <mesh material={parts.board} position={[cx, 0.05, BOX.z]} receiveShadow castShadow>
        <boxGeometry args={[len, 0.1, BOX.width + 0.2]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} material={parts.board} position={[cx, BOX.height / 2, BOX.z + side * (BOX.width / 2 + 0.05)]} receiveShadow castShadow>
          <boxGeometry args={[len, BOX.height, 0.1]} />
        </mesh>
      ))}
      {[0, len].map((dx) => (
        <mesh key={dx} material={parts.board} position={[BOX.x0 + dx, BOX.height / 2, BOX.z]} receiveShadow castShadow>
          <boxGeometry args={[0.1, BOX.height, BOX.width + 0.2]} />
        </mesh>
      ))}
      <primitive object={parts.cards} />
      <primitive object={parts.glows} />
      {DIVIDERS.map((d) => (
        <group key={d.name} position={[cardX(d.i) + BOX.pitch / 2, 0, BOX.z]}>
          <mesh position={[0, CARD_Y + 0.25, 0]} castShadow>
            <boxGeometry args={[0.02, CARD.h + 0.5, CARD.w + 0.1]} />
            <meshStandardMaterial color="#e9e2cf" roughness={0.7} />
          </mesh>
          {/* The tab is printed on both faces, so it never reads mirrored. */}
          <mesh position={[-0.02, CARD_Y + CARD.h / 2 + 0.55, -0.35]} rotation={[0, -Math.PI / 2, 0]} geometry={parts.tabGeo}>
            <meshStandardMaterial map={tabTex(d.name)} roughness={0.7} />
          </mesh>
          <mesh position={[0.02, CARD_Y + CARD.h / 2 + 0.55, -0.35]} rotation={[0, Math.PI / 2, 0]} geometry={parts.tabGeo}>
            <meshStandardMaterial map={tabTex(d.name)} roughness={0.7} />
          </mesh>
        </group>
      ))}
      {dots}
    </group>
  );
};

// ---------- the pulled card ----------
const HeroCard: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const face = new THREE.MeshPhysicalMaterial({ map: cardFaceTex(RESULTS[0]), roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, metalness: 0.05 });
    const back = new THREE.MeshStandardMaterial({ map: cardBackTex(), roughness: 0.4 });
    const holo = new THREE.MeshBasicMaterial({ map: holoTex(), transparent: true, opacity: 0.3, blending: ADD, depthWrite: false, toneMapped: false });
    return { face, back, holo };
  }, []);
  if (s < CUE.pull || s >= CUE.toDevice + 0.46) return null;
  const { pos, rotX, rotY, scale } = heroPose(s);
  const holoTexture = parts.holo.map!;
  holoTexture.offset.x = s * 0.35 + rotY * 0.4;
  parts.holo.opacity = 0.03 + 0.07 * Math.abs(Math.sin(rotY * 2 + s));
  return (
    <group position={pos} rotation={[rotX, rotY, 0]} scale={scale}>
      <mesh material={parts.face} castShadow>
        <planeGeometry args={[CARD.w, CARD.h]} />
      </mesh>
      <mesh material={parts.back} rotation={[0, Math.PI, 0]} position={[0, 0, -0.005]}>
        <planeGeometry args={[CARD.w, CARD.h]} />
      </mesh>
      <mesh material={parts.holo} position={[0, 0.513, 0.004]}>
        <planeGeometry args={[2.03, 1.61]} />
      </mesh>
    </group>
  );
};

// ---------- the proof mosaic: one tile per test clip ----------
const OLD_RIGHT = 103; // transcribe-then-search (Whisper base): 103/224
const tileInfo = Array.from({ length: TILE_COUNT }, (_, k) => {
  const { name, voice, col, row } = tileCell(k);
  const miss = NEW_MISSES.some(([n, v]) => n === BENCH_NAMES[name] && v === BENCH_VOICES[voice]);
  return { col, row, newOk: !miss, name };
});
// Which clips the old pipeline got right: the per-clip list wasn't kept, so the
// 103 are spread deterministically (Gengar, the motivating miss, is wrong).
{
  const order = tileInfo.map((_, k) => k).filter((k) => tileInfo[k].name !== 0).sort((a, b) => hash(a, 13) - hash(b, 13));
  const right = new Set(order.slice(0, OLD_RIGHT));
  tileInfo.forEach((t, k) => ((t as { oldOk?: boolean }).oldOk = right.has(k)));
}
const SCREEN_OUT = screenPoint(184, 224, 0.2);
export const MISS_TILES = tileInfo.map((t, k) => (t.newOk ? -1 : k)).filter((k) => k >= 0);
export const OLD_OK = tileInfo.filter((t) => (t as { oldOk?: boolean }).oldOk).length;
export const NEW_OK = tileInfo.filter((t) => t.newOk).length;

const Mosaic: React.FC<{ s: number }> = ({ s }) => {
  const { mesh, boost } = useMemo(() => {
    const boost = { value: 0.0 };
    const mat = instanceGlow(new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 }), boost);
    const mesh = new THREE.InstancedMesh(new RoundedBoxGeometry(0.8, 0.16, 0.8, 2, 0.05), mat, TILE_COUNT);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let k = 0; k < TILE_COUNT; k++) mesh.setColorAt(k, tmpColor.set("#2c3050"));
    return { mesh, boost };
  }, []);
  const [a] = CUE.tiles;
  mesh.visible = s >= a - 0.1 && s < CUE.lockup;
  if (!mesh.visible) return <primitive object={mesh} />;
  boost.value = 0.55 + hit(s) * 0.3;
  for (let k = 0; k < TILE_COUNT; k++) {
    const t = tileInfo[k];
    const [x, z] = tileXZ(t.col, t.row);
    const land = tileLand(k);
    // Each clip leaves the board's screen and arcs onto the mat.
    const fly = prog(s, land - 0.55, land);
    const bounce = s > land ? Math.abs(Math.sin((s - land) * 18)) * 0.35 * Math.exp(-(s - land) / 0.1) : 0;
    const src = SCREEN_OUT;
    const e = inOutCubic(fly);
    const fx = s < land ? lerp(src.x, x, e) : x, fz = s < land ? lerp(src.z, z, e) : z;
    const y = s < land ? lerp(src.y, 0.1, e) + Math.sin(e * Math.PI) * 3.2 : 0.1 + bounce;
    // Two flips: old verdict at the slam, new verdict in a wave.
    const f1 = prog(s, oldWave(t.col), oldWave(t.col) + 0.22);
    const f2 = prog(s, newWave(t.col), newWave(t.col) + 0.22);
    const rot = Math.PI * (outCubic(f1) + outCubic(f2));
    const base = ["#343a6e", "#3b3470", "#2e426a", "#413866"][t.row % 4];
    let col = base;
    if (f1 > 0.5) col = (t as { oldOk?: boolean }).oldOk ? C.owned : C.listen;
    if (f2 > 0.5) col = t.newOk ? C.owned : C.listen;
    const dim = s >= CUE.oldPass && f2 < 0.5 && !(t as { oldOk?: boolean }).oldOk ? 1 : 1;
    const out = prog(s, CUE.outro, CUE.outro + 1.2);
    dummy.position.set(fx, y - out * 0.3, fz);
    dummy.rotation.set(rot + (1 - e) * (s < land ? 2.5 : 0), (1 - e) * (s < land ? 1.2 : 0), 0);
    dummy.scale.setScalar(s < land - 0.55 ? 0.0001 : (s < land ? lerp(0.35, 1, e) : 1) * (1 - out * 0.999));
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    tmpColor.set(col).multiplyScalar(dim);
    if (s >= land && s < land + 0.35) tmpColor.lerp(new THREE.Color(2.2, 2.2, 2.6), Math.exp(-(s - land) / 0.08));
    // The three misses pulse when the camera finds them.
    const mi = MISS_TILES.indexOf(k);
    if (mi >= 0 && s >= CUE.misses[mi]) tmpColor.multiplyScalar(1.4 + 0.6 * Math.sin((s - CUE.misses[mi]) * 9) ** 2);
    mesh.setColorAt(k, tmpColor);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor!.needsUpdate = true;
  return <primitive object={mesh} />;
};

// The three clips name scoring still gets wrong, labelled in place.
const MissLabels: React.FC<{ s: number }> = ({ s }) => {
  if (s < CUE.misses[0] || s >= CUE.outro + 0.3) return null;
  const out = 1 - prog(s, CUE.outro, CUE.outro + 0.3);
  return (
    <>
      {MISS_TILES.map((k, i) => {
        const { col, row, name, voice } = tileCell(k);
        const [x, z] = tileXZ(col, row);
        const kk = outBack(prog(s, CUE.misses[i], CUE.misses[i] + 0.3), 2.5) * out;
        if (kk <= 0) return null;
        const label = `${BENCH_NAMES[name]} · ${BENCH_VOICES[voice]}`;
        return (
          <sprite key={k} position={[x + (i === 0 ? 0 : -2.7), 0.9 + kk * 0.4, z + (i === 0 ? 1.05 : i === 2 ? 0.45 : -0.45)]} scale={[3.4 * kk, 0.68 * kk, 1]}>
            <spriteMaterial map={missTex(label)} transparent depthTest={false} toneMapped={false} />
          </sprite>
        );
      })}
    </>
  );
};

// ---------- the Poké Ball (the firmware's spinner, made solid) ----------
const PokeBall: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const r = BALL.r;
    const red = new THREE.MeshPhysicalMaterial({ color: "#e3262d", roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 });
    const white = new THREE.MeshPhysicalMaterial({ color: "#f3f1f6", roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
    const black = new THREE.MeshStandardMaterial({ color: "#121216", roughness: 0.5 });
    const glow = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0, roughness: 0.3 });
    return {
      top: new THREE.SphereGeometry(r, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2 - 0.05),
      bottom: new THREE.SphereGeometry(r, 64, 32, 0, Math.PI * 2, Math.PI / 2 + 0.05, Math.PI / 2 - 0.05),
      band: new THREE.CylinderGeometry(r * 0.985, r * 0.985, 0.19, 64),
      ring: new THREE.CylinderGeometry(0.34, 0.34, 0.12, 48),
      button: new THREE.CylinderGeometry(0.22, 0.22, 0.14, 48),
      red, white, black, glow,
    };
  }, []);
  const [a, b] = CUE.roll;
  if (s < a) return null;
  // Exactly two turns, so the band lands level with the button facing us.
  const dist = 4 * Math.PI * BALL.r;
  const u = outCubic(prog(s, a, b));
  const x = BALL.to + dist * (1 - u);
  const wob = s > b ? Math.sin((s - b) * 14) * 0.12 * Math.exp(-(s - b) / 0.25) : 0;
  const rollAngle = -(x - BALL.to) / BALL.r;
  parts.glow.emissiveIntensity = s >= CUE.lockup ? 2.5 * Math.exp(-(s - CUE.lockup) / 0.4) + 0.4 + 0.2 * Math.sin(s * 5) : 0;
  return (
    <group position={[x, BALL.r + 0.02, BALL.z]} rotation={[0, 0, rollAngle + wob]}>
      <mesh geometry={parts.top} material={parts.red} castShadow />
      <mesh geometry={parts.bottom} material={parts.white} castShadow />
      <mesh geometry={parts.band} material={parts.black} />
      <group rotation={[Math.PI / 2, 0, 0]} position={[0, 0, BALL.r * 0.93]}>
        <mesh geometry={parts.ring} material={parts.black} />
        <mesh geometry={parts.button} material={parts.glow} position={[0, 0.03, 0]} />
      </group>
    </group>
  );
};

// ---------- sparks on the pull and the payoff ----------
const Sparks: React.FC<{ s: number }> = ({ s }) => {
  const soft = softTex();
  const bursts: { t: number; at: THREE.Vector3; n: number; color: string; speed: number }[] = [
    { t: CUE.pull, at: new THREE.Vector3(cardX(WINNER), CARD_Y + CARD.h / 2 + 2, BOX.z), n: 60, color: C.holoGold, speed: 7 },
    { t: CUE.newPass, at: new THREE.Vector3(GRID.cx, 0.5, GRID.cz), n: 90, color: C.owned, speed: 11 },
    { t: CUE.lockup, at: new THREE.Vector3(BALL.to, BALL.r, BALL.z + 0.9), n: 50, color: "#ffffff", speed: 4 },
  ];
  const out: React.ReactNode[] = [];
  for (const [bi, b] of bursts.entries()) {
    const d = s - b.t;
    if (d < 0 || d > 1.4) continue;
    for (let i = 0; i < b.n; i++) {
      const th = hash(i, bi + 20) * Math.PI * 2, ph = hash(i, bi + 40) * Math.PI * 0.5;
      const v = b.speed * (0.4 + hash(i, bi + 60) * 0.6);
      const p = new THREE.Vector3(Math.cos(th) * Math.cos(ph) * v * d, Math.sin(ph) * v * d - 4.9 * d * d, Math.sin(th) * Math.cos(ph) * v * d).add(b.at);
      const life = 1 - d / (0.8 + hash(i, bi + 80) * 0.6);
      if (life <= 0) continue;
      const k = 0.18 * life + 0.04;
      out.push(
        <sprite key={`${bi}-${i}`} position={p} scale={[k, k, 1]}>
          <spriteMaterial map={soft} color={new THREE.Color(b.color).multiplyScalar(3)} transparent opacity={life} depthWrite={false} blending={ADD} toneMapped={false} />
        </sprite>,
      );
    }
  }
  return <>{out}</>;
};

export { clamp, spring };

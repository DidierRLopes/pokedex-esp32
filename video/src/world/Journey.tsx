// On the go: the board runs from a power bank, reaches the iPhone hotspot
// over Wi-Fi, and a parcel (the spoken name) travels a delivery-tracking
// route across the internet, through the Tailscale Funnel gate, to the Mac
// mini at home. The answer (the real card, ✓ and price) travels back.
import React, { useMemo } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CUE, SPOKEN } from "../cues.ts";
import { C, SANS } from "../theme.ts";
import { OWNED_INDEX, RESULTS, cardArt, price } from "../data.ts";
import { clamp, inCubic, inOutCubic, lerp, outBack, outCubic, prog } from "../anim.ts";
import { BOARD, BOARD_POS } from "./layout.ts";
import { artTex, pillAspect, pillTex, softTex } from "./textures.ts";

const ADD = THREE.AdditiveBlending;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------- where everything sits (cm) ----------
export const BANK = { pos: V(7.5, 0.72, -2.5), size: [5.6, 1.4, 9.2] as const, rotY: 0.35 };
export const PHONE = { pos: V(15, 7.6, -3), size: [7.15, 14.7, 0.8] as const, rotY: -0.35 };
export const GATE = { pos: V(38, 30, -18), radius: 5.5 };
export const MAC = { pos: V(66, 1.8, -8), size: [19.7, 3.6, 19.7] as const, rotY: -0.45 };
export const HOUSE = { pos: V(66, 0, -8), w: 44, wall: 24, peak: 42 };

// The route: screen → phone (Wi-Fi), then phone → gate → Mac mini (internet).
const SCREEN = BOARD_POS.clone().add(V(0, BOARD.screen.y, 0.9));
const LOCAL = new THREE.CatmullRomCurve3([SCREEN, V(7, 9.5, -1), PHONE.pos.clone().add(V(0, 2, 0.6))]);
export const ROUTE = new THREE.CatmullRomCurve3([
  PHONE.pos.clone().add(V(0, 7.5, 0)), V(22, 22, -9), GATE.pos.clone().add(V(-4, 0, 0)), GATE.pos.clone(),
  GATE.pos.clone().add(V(4, 0, 0)), V(54, 24, -14), MAC.pos.clone().add(V(0, 14, 0)), MAC.pos.clone().add(V(0, 2.5, 0)),
]);
// Parameter on ROUTE where the gate sits (so the parcel crosses it on its cue).
const GATE_U = (() => {
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= 400; i++) {
    const d = ROUTE.getPointAt(i / 400).distanceTo(GATE.pos);
    if (d < bestD) { bestD = d; best = i / 400; }
  }
  return best;
})();

// Where the outgoing parcel is; exported so the camera can chase it.
export function parcelAt(s: number): THREE.Vector3 | null {
  if (s < CUE.rings[0] || s > CUE.atMac + 0.3) return null;
  if (s < CUE.launch) return LOCAL.getPointAt(inOutCubic(prog(s, CUE.rings[0], CUE.atPhone)));
  // Launch → gate → Mac mini, crossing the gate exactly on its cue.
  const u = s < CUE.gate
    ? GATE_U * inCubic(prog(s, CUE.launch, CUE.gate)) ** 0.8
    : GATE_U + (1 - GATE_U) * outCubic(prog(s, CUE.gate, CUE.atMac));
  return ROUTE.getPointAt(clamp(u));
}
// The reply runs the whole route backwards, in one breath.
export function replyAt(s: number): THREE.Vector3 | null {
  if (s < CUE.reply || s > CUE.backOnBoard + 0.05) return null;
  const u = inOutCubic(prog(s, CUE.reply, CUE.backOnBoard));
  const k = u * 2; // first the internet leg, then the local one
  return k < 1.6 ? ROUTE.getPointAt(clamp(1 - k / 1.6)) : LOCAL.getPointAt(clamp(1 - (k - 1.6) / 0.4));
}

// ---------- small canvas textures ----------
const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const tex = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
let phoneScreen: THREE.CanvasTexture | null = null;
function phoneTex() {
  if (phoneScreen) return phoneScreen;
  const c = canvas(512, 1054);
  const g = c.getContext("2d")!;
  g.fillStyle = "#050507";
  g.fillRect(0, 0, 512, 1054);
  const glow = g.createRadialGradient(256, 520, 20, 256, 520, 420);
  glow.addColorStop(0, "rgba(52,211,153,0.28)");
  glow.addColorStop(1, "rgba(52,211,153,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 512, 1054);
  g.fillStyle = "#ffffff";
  g.font = `800 64px ${SANS}`;
  g.textAlign = "center";
  g.fillText("Personal", 256, 210);
  g.fillText("Hotspot", 256, 285);
  // Two chain links: the hotspot glyph.
  g.strokeStyle = C.owned;
  g.lineWidth = 34;
  g.lineCap = "round";
  for (const [x, y] of [[196, 480], [316, 590]]) {
    g.beginPath();
    g.roundRect(x - 90, y - 50, 180, 100, 50);
    g.stroke();
  }
  g.fillStyle = C.owned;
  g.font = `800 64px ${SANS}`;
  g.fillText("1 Connection", 256, 800);
  phoneScreen = tex(c);
  return phoneScreen;
}
let lock: { open: THREE.CanvasTexture; shut: THREE.CanvasTexture } | null = null;
function lockTex(open: boolean) {
  if (!lock) {
    const draw = (isOpen: boolean) => {
      const c = canvas(256, 256);
      const g = c.getContext("2d")!;
      g.strokeStyle = isOpen ? C.owned : C.lilac;
      g.fillStyle = isOpen ? C.owned : C.lilac;
      g.lineWidth = 22;
      g.beginPath();
      g.arc(128, isOpen ? 78 : 104, 50, Math.PI, 0);
      g.lineTo(178, isOpen ? 90 : 128);
      if (!isOpen) g.moveTo(78, 104), g.lineTo(78, 128);
      g.stroke();
      g.beginPath();
      g.roundRect(58, 124, 140, 104, 18);
      g.fill();
      g.fillStyle = "#0a0a16";
      g.beginPath();
      g.arc(128, 166, 14, 0, Math.PI * 2);
      g.fill();
      g.fillRect(122, 172, 12, 30);
      return tex(c);
    };
    lock = { open: draw(true), shut: draw(false) };
  }
  return open ? lock.open : lock.shut;
}

// ---------- the pieces ----------
const Pill: React.FC<{ t: THREE.Texture; pos: THREE.Vector3; h: number; k: number }> = ({ t, pos, h, k }) =>
  k <= 0 ? null : (
    <sprite position={pos} scale={[h * pillAspect(t) * k, h * k, 1]}>
      <spriteMaterial map={t} transparent depthTest={false} toneMapped={false} />
    </sprite>
  );

export const PowerBank: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => ({
    body: new RoundedBoxGeometry(BANK.size[0], BANK.size[1], BANK.size[2], 4, 0.5),
    mat: new THREE.MeshPhysicalMaterial({ color: "#1d1e24", roughness: 0.55, clearcoat: 0.4 }),
    led: new THREE.MeshBasicMaterial({ color: new THREE.Color("#6ea8ff").multiplyScalar(2.5), toneMapped: false }),
  }), []);
  if (s < CUE.bank - 0.05) return null;
  const k = outBack(prog(s, CUE.bank, CUE.bank + 0.4), 1.4);
  const pos = BANK.pos.clone().add(V((1 - k) * 18, 0, (1 - k) * 4));
  const lit = s >= CUE.plugIn ? 1 : 0;
  return (
    <group position={pos} rotation={[0, BANK.rotY - (1 - k) * 0.6, 0]}>
      <mesh geometry={parts.body} material={parts.mat} castShadow receiveShadow />
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[BANK.size[0] / 2 + 0.01, 0.1, -1.5 + i * 0.9]} rotation={[0, Math.PI / 2, 0]} material={parts.led} visible={lit > 0 && s >= CUE.plugIn + i * 0.08}>
          <circleGeometry args={[0.16, 16]} />
        </mesh>
      ))}
    </group>
  );
};

export const Phone: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => ({
    body: new RoundedBoxGeometry(PHONE.size[0], PHONE.size[1], PHONE.size[2], 5, 1.0),
    mat: new THREE.MeshPhysicalMaterial({ color: "#2b2d33", metalness: 0.8, roughness: 0.25, clearcoat: 0.6 }),
    screen: new THREE.MeshBasicMaterial({ map: phoneTex(), toneMapped: false }),
  }), []);
  if (s < CUE.connect + 0.4 || s > CUE.reply + 0.6) return null;
  const k = outBack(prog(s, CUE.plugIn + 0.05, CUE.rings[0] + 0.1), 1.3) * (1 - inCubic(prog(s, CUE.reply + 0.2, CUE.reply + 0.6)));
  const glow = s >= CUE.atPhone ? 1 + 0.6 * Math.exp(-(s - CUE.atPhone) / 0.2) : 1;
  parts.screen.color.setScalar(glow);
  return (
    <group position={PHONE.pos.clone().add(V(0, (1 - k) * -8, 0))} rotation={[0, PHONE.rotY, 0]} scale={Math.max(0.001, k)}>
      <mesh geometry={parts.body} material={parts.mat} castShadow />
      <mesh position={[0, 0, PHONE.size[2] / 2 + 0.01]} material={parts.screen}>
        <planeGeometry args={[PHONE.size[0] - 0.6, PHONE.size[1] - 0.6]} />
      </mesh>
    </group>
  );
};

// Wi-Fi arcs spreading from the board toward the phone.
export const WifiRings: React.FC<{ s: number }> = ({ s }) => {
  const dir = Math.atan2(PHONE.pos.y - BOARD_POS.y, PHONE.pos.x - BOARD_POS.x);
  return (
    <>
      {CUE.rings.map((t) => {
        const d = s - t;
        if (d < 0 || d > 0.9) return null;
        const r = 2 + outCubic(d / 0.9) * 10.5;
        return (
          <mesh key={t} position={[BOARD_POS.x + 1.5, BOARD_POS.y + 0.5, 0.5]}>
            <ringGeometry args={[r, r + 0.35, 48, 1, dir - 0.5, 1.0]} />
            <meshBasicMaterial color={new THREE.Color(C.violet).multiplyScalar(2)} transparent opacity={(1 - d / 0.9) * 0.9} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </>
  );
};

// The route drawn as glowing dots; it lights up as the parcel first travels it.
export const Route: React.FC<{ s: number }> = ({ s }) => {
  const dots = useMemo(() => Array.from({ length: 170 }, (_, i) => ROUTE.getPointAt(i / 169)), []);
  const soft = softTex();
  if (s < CUE.launch - 0.1 || s > CUE.lockup + 0.4) return null;
  const drawn = s < CUE.atMac ? clamp(prog(s, CUE.launch, CUE.atMac) * 1.15) : 1;
  const head = parcelAt(s) ?? replyAt(s);
  const fade = 1 - prog(s, CUE.lockup, CUE.lockup + 0.4);
  return (
    <>
      {dots.map((p, i) => {
        if (i / 169 > drawn) return null;
        const near = head ? Math.exp(-p.distanceTo(head) / 4) : 0;
        const k = 0.45 + near * 1.2;
        return (
          <sprite key={i} position={p} scale={[k, k, 1]}>
            <spriteMaterial map={soft} color={new THREE.Color(near > 0.3 ? C.amber : C.violet).multiplyScalar(1.4 + near * 2)} transparent opacity={(0.55 + near * 0.45) * fade} depthWrite={false} blending={ADD} toneMapped={false} />
          </sprite>
        );
      })}
    </>
  );
};

// Tailscale Funnel: a ring gate with a padlock that opens for the token.
export const Gate: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => ({
    ring: new THREE.TorusGeometry(GATE.radius, 0.45, 24, 96),
    mat: new THREE.MeshStandardMaterial({ color: "#20183f", emissive: new THREE.Color(C.violet), emissiveIntensity: 1.2, metalness: 0.6, roughness: 0.3 }),
  }), []);
  if (s < CUE.launch - 0.2 || s > CUE.lockup + 0.4) return null;
  const k = outBack(prog(s, CUE.launch - 0.1, CUE.launch + 0.4), 1.5);
  const open = s >= CUE.gate;
  const pass = open ? Math.exp(-(s - CUE.gate) / 0.3) : 0;
  parts.mat.emissive.set(open ? C.owned : C.violet);
  parts.mat.emissiveIntensity = 1.2 + pass * 3;
  const label = pillTex("Tailscale Funnel · HTTPS", open ? C.owned : C.violet);
  return (
    <group>
      <mesh geometry={parts.ring} material={parts.mat} position={GATE.pos} rotation={[0, Math.PI / 2, 0]} scale={Math.max(0.001, k)} />
      <sprite position={GATE.pos.clone().add(V(0, 0, 0.5))} scale={[3.6 * k * (1 + pass * 0.3), 3.6 * k * (1 + pass * 0.3), 1]}>
        <spriteMaterial map={lockTex(open)} transparent depthTest={false} toneMapped={false} />
      </sprite>
      <Pill t={label} pos={GATE.pos.clone().add(V(0, -GATE.radius - 2.4, 0))} h={2.2} k={k} />
    </group>
  );
};

// The Mac mini at home, under a glowing house outline.
export const MacMini: React.FC<{ s: number }> = ({ s }) => {
  const parts = useMemo(() => {
    const { w, wall, peak } = HOUSE;
    const outline = new THREE.CatmullRomCurve3([
      V(-w / 2, 0, 0), V(-w / 2, wall, 0), V(0, peak, 0), V(w / 2, wall, 0), V(w / 2, 0, 0),
    ], false, "catmullrom", 0);
    return {
      body: (() => {
        const w = MAC.size[0], r = 3.2, b = 0.35;
        const sh = new THREE.Shape();
        const h = (w - 2 * b) / 2, rr = r - b;
        sh.moveTo(-h + rr, -h);
        sh.lineTo(h - rr, -h); sh.quadraticCurveTo(h, -h, h, -h + rr);
        sh.lineTo(h, h - rr); sh.quadraticCurveTo(h, h, h - rr, h);
        sh.lineTo(-h + rr, h); sh.quadraticCurveTo(-h, h, -h, h - rr);
        sh.lineTo(-h, -h + rr); sh.quadraticCurveTo(-h, -h, -h + rr, -h);
        return new THREE.ExtrudeGeometry(sh, { depth: MAC.size[1] - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 20 })
          .rotateX(-Math.PI / 2).translate(0, -(MAC.size[1] - 2 * b) / 2, 0);
      })(),
      mat: new THREE.MeshPhysicalMaterial({ color: "#c9ccd3", metalness: 1, roughness: 0.28, clearcoat: 0.3 }),
      base: new THREE.CylinderGeometry(7.5, 7.5, 0.4, 64),
      baseMat: new THREE.MeshStandardMaterial({ color: "#1a1b20", roughness: 0.7 }),
      led: new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffffff").multiplyScalar(2), toneMapped: false }),
      house: new THREE.TubeGeometry(outline, 200, 0.35, 8, false),
      houseMat: new THREE.MeshBasicMaterial({ color: new THREE.Color(C.amber).multiplyScalar(1.6), toneMapped: false, transparent: true }),
    };
  }, []);
  if (s < CUE.launch || s > CUE.lockup + 0.4) return null;
  const k = outCubic(prog(s, CUE.launch + 0.2, CUE.gate + 0.3));
  const busy = s >= CUE.atMac && s < CUE.reply + 0.2 ? 1 : 0;
  parts.led.color.setScalar(1.2 + busy * (1 + Math.sin(s * 30)));
  parts.houseMat.opacity = k * (1 - prog(s, CUE.lockup, CUE.lockup + 0.4));
  const chips = [
    pillTex(`Whisper picks “${SPOKEN}”`, C.listen),
    pillTex("card catalog", C.violet),
    pillTex("Pokévault ✓ / ✗", C.owned),
    pillTex("live prices", C.amber),
  ];
  return (
    <group>
      <mesh geometry={parts.house} material={parts.houseMat} position={[HOUSE.pos.x, HOUSE.pos.y, HOUSE.pos.z - 10]} />
      <group position={MAC.pos} rotation={[0, MAC.rotY, 0]}>
        <mesh geometry={parts.body} material={parts.mat} castShadow receiveShadow position={[0, MAC.size[1] / 2 + 0.3, 0]} />
        <mesh geometry={parts.base} material={parts.baseMat} position={[0, 0.2, 0]} />
        <mesh position={[MAC.size[0] / 2 - 1.2, MAC.size[1] / 2 + 0.3, MAC.size[2] / 2 + 0.01]} material={parts.led}>
          <circleGeometry args={[0.18, 16]} />
        </mesh>
      </group>
      {chips.map((t, i) => {
        // Stacked above the Mac mini, in the order the work happens.
        const pk = outBack(prog(s, CUE.chips[i], CUE.chips[i] + 0.3), 2) * (1 - prog(s, CUE.reply - 0.2, CUE.reply + 0.15));
        const p = MAC.pos.clone().add(V(0, 16.5 - i * 3.6, 4));
        return <Pill key={i} t={t} pos={p} h={3.2} k={pk} />;
      })}
    </group>
  );
};

// The parcel out (the spoken name) and the answer back (the card you own).
export const Parcels: React.FC<{ s: number }> = ({ s }) => {
  const out = parcelAt(s);
  const back = replyAt(s);
  const card = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true }), []);
  const soft = softTex();
  const r = RESULTS[OWNED_INDEX];
  card.map = artTex(cardArt(r));
  const word = pillTex(`“${SPOKEN}”`, C.listen);
  const own = pillTex(price(r.price), C.owned, "✓");
  const intoMac = prog(s, CUE.atMac - 0.15, CUE.atMac + 0.1);
  const intoScreen = prog(s, CUE.backOnBoard - 0.2, CUE.backOnBoard);
  // Grow with distance so the parcel reads on the wide shots.
  const size = (p: THREE.Vector3) => lerp(1, 3.2, clamp(p.distanceTo(SCREEN) / 30));
  return (
    <>
      {out && (
        <>
          <sprite position={out} scale={[size(out) * 1.3, size(out) * 1.3, 1]}>
            <spriteMaterial map={soft} color={new THREE.Color(C.listen).multiplyScalar(2.5)} transparent depthWrite={false} blending={ADD} toneMapped={false} />
          </sprite>
          <Pill t={word} pos={out.clone().add(V(0, size(out) * 1.4, 0))} h={size(out) * 0.9} k={1 - intoMac} />
        </>
      )}
      {back && (
        <group position={back}>
          <mesh material={card} scale={lerp(size(back) * 1.4, 0.5, intoScreen)}>
            <planeGeometry args={[2.5, 2.5 * (825 / 600)]} />
          </mesh>
          <Pill t={own} pos={V(0, -size(back) * 2.8, 0.2)} h={size(back) * 0.9} k={1 - intoScreen} />
        </group>
      )}
    </>
  );
};

export const Journey: React.FC<{ s: number }> = ({ s }) => (
  <>
    <PowerBank s={s} />
    <Phone s={s} />
    <WifiRings s={s} />
    <Route s={s} />
    <Gate s={s} />
    <MacMini s={s} />
    <Parcels s={s} />
  </>
);

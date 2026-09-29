// Type layers: one header per shot saying what is happening, the spoken
// card name, the lockup, and the thumbnail's words. Built to read with the
// sound off.
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { CUE, SPOKEN } from "../cues.ts";
import { C, MONO, SANS } from "../theme.ts";
import { RESULTS } from "../data.ts";
import { clamp, inCubic, lerp, outCubic, prog, spring } from "../anim.ts";

// A line that punches in at `at` and leaves at `until`.
const Line: React.FC<{ s: number; at: number; until: number; children: React.ReactNode }> = ({ s, at, until, children }) => {
  if (s < at || s > until) return null;
  const k = spring(s, at, 3.2, 0.45);
  const out = prog(s, until - 0.15, until);
  return (
    <div style={{ position: "absolute", left: 110, top: 84, fontFamily: SANS, fontWeight: 800, fontSize: 60, color: C.white, letterSpacing: -1.2, whiteSpace: "nowrap", textShadow: "0 4px 30px rgba(0,0,0,0.7)", transform: `translateY(${(1 - k) * 40 - out * 20}px)`, opacity: clamp(k * 1.6) * (1 - out), filter: `blur(${(1 - clamp(k)) * 6 + out * 8}px)` }}>
      {children}
    </div>
  );
};
const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 7, background: color, marginRight: 22, boxShadow: `0 0 20px ${color}`, transform: "translateY(-10px)" }} />
);
const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 44, padding: "4px 16px", borderRadius: 12, border: `3px solid ${C.violet}`, color: C.lilac, marginRight: 18, transform: "translateY(-4px)", display: "inline-block" }}>{children}</span>
);

export const Headers: React.FC<{ s: number }> = ({ s }) => (
  <>
    <Line s={s} at={0.3} until={CUE.search}><Dot color={C.listen} />Hold the screen. Say a card.</Line>
    <Line s={s} at={CUE.result + 0.1} until={CUE.presses[0] - 0.1}><Dot color={C.amber} />The card, if you own it, what it costs.</Line>
    <Line s={s} at={CUE.presses[0]} until={CUE.fan}><Key>PWR</Key>next printing</Line>
    <Line s={s} at={CUE.fan + 0.2} until={CUE.connect}><Dot color={C.owned} />All {RESULTS.length} {SPOKEN} printings, owned or not, priced.</Line>
    <Line s={s} at={CUE.connect + 0.1} until={CUE.rings[0] - 0.05}><Dot color={C.lilac} />At a card show? No laptop.</Line>
    <Line s={s} at={CUE.rings[0]} until={CUE.launch - 0.05}><Dot color={C.violet} />Wi-Fi to your phone's hotspot</Line>
    <Line s={s} at={CUE.launch} until={CUE.atMac - 0.1}><Dot color={C.owned} />Across the internet, through Tailscale Funnel</Line>
    <Line s={s} at={CUE.atMac - 0.05} until={CUE.reply}><Dot color={C.amber} />Your Mac mini at home does the work</Line>
    <Line s={s} at={CUE.reply + 0.05} until={CUE.lockup}><Dot color={C.owned} />…and the answer comes back to the board.</Line>
  </>
);

// The spoken name flies in from the speaker's side and into the board.
export const Spoken: React.FC<{ s: number }> = ({ s }) => {
  const a = CUE.word, b = CUE.release;
  if (s < a || s > b + 0.1) return null;
  const k = spring(s, a, 2.6, 0.5);
  const into = inCubic(prog(s, b - 0.45, b));
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 150, color: C.white, letterSpacing: -4, textShadow: `0 0 40px ${C.listen}, 0 6px 30px rgba(0,0,0,0.8)`, transform: `translate(${lerp(420, 0, clamp(k))}px, ${lerp(-60, 0, clamp(k)) + into * 40}px) scale(${lerp(1.2, 1, clamp(k)) * lerp(1, 0.05, into)})`, opacity: clamp(k * 2) * (1 - into * 0.6) }}>
        “{SPOKEN}”
      </div>
    </AbsoluteFill>
  );
};

// ---------- lockup ----------
export const Wordmark: React.FC<{ size: number; k?: number }> = ({ size, k = 1 }) => (
  <div style={{ fontFamily: SANS, fontWeight: 900, fontSize: size, letterSpacing: -size * 0.045, color: C.white, lineHeight: 1, display: "flex", alignItems: "center" }}>
    <span>P</span>
    <Img src={staticFile("pokeball.png")} style={{ width: size * 0.74, height: size * 0.74, margin: `0 ${size * 0.01}px`, transform: `rotate(${(1 - k) * -540}deg) translateY(${size * 0.04}px)` }} />
    <span>ke</span>
    <span style={{ color: C.violet }}>Dex</span>
  </div>
);

export const Lockup: React.FC<{ s: number }> = ({ s }) => {
  if (s < CUE.lockup - 0.05) return null;
  const k = spring(s, CUE.lockup, 2.4, 0.42);
  const rise = (at: number) => {
    const v = spring(s, at, 3, 0.5);
    return { opacity: clamp(v * 1.4), transform: `translateY(${(1 - clamp(v)) * 24}px)` };
  };
  return (
    <AbsoluteFill style={{ alignItems: "center", fontFamily: SANS }}>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,6,13,0.85) 0%, rgba(5,6,13,0.25) 40%, rgba(5,6,13,0) 55%, rgba(5,6,13,0.75) 100%)" }} />
      <div style={{ position: "absolute", top: 60, transform: `scale(${lerp(0.8, 1, clamp(k))})`, opacity: clamp(k * 1.5), filter: `blur(${(1 - clamp(k)) * 10}px)` }}>
        <Wordmark size={160} k={clamp(k)} />
      </div>
      <div style={{ position: "absolute", top: 250, fontSize: 50, fontWeight: 700, color: "#e6e2ff", ...rise(CUE.lockTag) }}>
        Say a card. <span style={{ color: C.owned }}>Know if you own it.</span> <span style={{ color: C.amber }}>Know what to pay.</span>
      </div>
      <div style={{ position: "absolute", bottom: 150, fontSize: 30, fontWeight: 600, color: "#d6d9ee", ...rise(CUE.lockVault) }}>
        <span style={{ color: C.owned }}>✓</span> / <span style={{ color: C.listen }}>✗</span> synced with your Pokévault collection · live TCGplayer prices
      </div>
      <div style={{ position: "absolute", bottom: 64, textAlign: "center", ...rise(CUE.lockUrl) }}>
        <div style={{ fontFamily: MONO, fontSize: 36, fontWeight: 500, color: C.white }}>github.com/DidierRLopes/pokedex-esp32</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: C.muted, marginTop: 10, letterSpacing: 0.5 }}>ESP32-S3 AMOLED board · Whisper on your Mac: over USB at the desk, or a Mac mini via hotspot + Tailscale on the go</div>
      </div>
    </AbsoluteFill>
  );
};

// The feed thumbnail: the product doing its job, with the name and promise.
export const PosterType: React.FC = () => (
  <AbsoluteFill style={{ fontFamily: SANS }}>
    <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(5,6,13,0.9) 0%, rgba(5,6,13,0.45) 36%, rgba(5,6,13,0) 52%)" }} />
    <div style={{ position: "absolute", left: 90, top: 330 }}>
      <Wordmark size={124} />
      <div style={{ fontSize: 48, fontWeight: 700, color: "#e6e2ff", marginTop: 28, lineHeight: 1.25 }}>
        Say a card.<br /><span style={{ color: C.owned }}>Know if you own it.</span><br /><span style={{ color: C.amber }}>Know what to pay.</span>
      </div>
    </div>
  </AbsoluteFill>
);

export { outCubic };

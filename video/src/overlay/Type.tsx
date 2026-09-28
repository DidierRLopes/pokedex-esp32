// Type layers: one header per shot saying what is happening, the proof
// numbers with their disclosure, and the lockup.
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { CUE, SHORTLIST } from "../cues.ts";
import { C, MONO, SANS } from "../theme.ts";
import { NAMES, RESULTS } from "../data.ts";
import { clamp, inCubic, inOutCubic, lerp, outBack, outCubic, outExpo, prog, spring } from "../anim.ts";
import { NEW_OK, OLD_OK } from "../world/World.tsx";

const TOTAL = 224;
const pct = (n: number) => Math.round((n / TOTAL) * 100);

// A word that punches in (scale + blur) at `at` and leaves at `until`.
const Word: React.FC<{ s: number; at: number; until: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ s, at, until, children, style }) => {
  const k = spring(s, at, 3.2, 0.45);
  const out = prog(s, until - 0.15, until);
  if (s < at || s > until) return null;
  return (
    <span style={{ display: "inline-block", transform: `translateY(${(1 - k) * 40 - out * 20}px) scale(${lerp(0.7, 1, clamp(k))})`, opacity: clamp(k * 1.6) * (1 - out), filter: `blur(${(1 - clamp(k)) * 6 + out * 8}px)`, ...style }}>
      {children}
    </span>
  );
};

const headerStyle: React.CSSProperties = {
  position: "absolute", left: 110, top: 86, fontFamily: SANS, fontWeight: 800, fontSize: 64,
  color: C.white, letterSpacing: -1.5, textShadow: "0 4px 30px rgba(0,0,0,0.6)", whiteSpace: "nowrap",
};
const tagStyle = (color: string): React.CSSProperties => ({
  display: "inline-block", width: 14, height: 14, borderRadius: 7, background: color, marginRight: 22,
  boxShadow: `0 0 20px ${color}`, transform: "translateY(-10px)",
});

export const Headers: React.FC<{ s: number }> = ({ s }) => {
  // Live count for the pull: 736 names -> 48 close -> 1.
  const toShort = prog(s, CUE.shortlist, CUE.shortlist + 1.4);
  const count = s >= CUE.pull ? 1 : Math.round(lerp(NAMES.length, SHORTLIST, toShort));
  const pullLabel = s < CUE.shortlist ? "card names" : s < CUE.pull ? "sound close" : "pulled: Gengar";
  // Tiles landed so far.
  const landed = Math.round(TOTAL * clamp((s - CUE.tiles[0]) / (CUE.tiles[1] - 0.2 - CUE.tiles[0])));
  return (
    <>
      <div style={headerStyle}>
        <Word s={s} at={CUE.press} until={CUE.release + 0.2}><span style={tagStyle(C.listen)} />Hold.&nbsp;</Word>
        <Word s={s} at={CUE.voice - 0.2} until={CUE.release + 0.2}>Say a card.</Word>
      </div>
      <div style={headerStyle}>
        <Word s={s} at={CUE.wrong + 0.15} until={CUE.rewind}><span style={tagStyle(C.listen)} />Speech-to-text heard:</Word>
      </div>
      {s >= CUE.count && s < CUE.toDevice && (
        <div style={headerStyle}>
          <Word s={s} at={CUE.count} until={CUE.toDevice}>
            <span style={tagStyle(s < CUE.shortlist ? C.listen : s < CUE.pull ? C.amber : C.violet)} />
            <span style={{ fontVariantNumeric: "tabular-nums", color: s >= CUE.pull ? C.violet : C.white }}>{count}</span>{" "}
            <span style={{ fontWeight: 600, color: "#d6d9ee" }}>{pullLabel}</span>
          </Word>
        </div>
      )}
      <div style={headerStyle}>
        <Word s={s} at={CUE.rows[0]} until={CUE.presses[0] - 0.1}><span style={tagStyle(C.amber)} />Onto the screen.</Word>
      </div>
      <div style={headerStyle}>
        <Word s={s} at={CUE.presses[0]} until={CUE.tiles[0] + 0.1}><span style={tagStyle(C.violet)} />Side button: next printing</Word>
      </div>
      {s >= CUE.tiles[0] + 0.15 && s < CUE.oldPass && (
        <div style={headerStyle}>
          <Word s={s} at={CUE.tiles[0] + 0.15} until={CUE.oldPass}>
            <span style={tagStyle(C.muted)} />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{landed}</span> spoken names
          </Word>
        </div>
      )}
    </>
  );
};

// ---------- proof ----------
export const Proof: React.FC<{ s: number }> = ({ s }) => {
  if (s < CUE.oldPass - 0.05 || s > CUE.outro + 0.4) return null;
  const out = prog(s, CUE.outro, CUE.outro + 0.35);
  const oldIn = spring(s, CUE.oldPass, 2.6, 0.4);
  const newIn = spring(s, CUE.newPass, 2.2, 0.35);
  const shift = outCubic(prog(s, CUE.newWave[0], CUE.newPass));
  const dock = inOutCubic(prog(s, CUE.misses[0] - 0.6, CUE.misses[0]));
  const oldNum = Math.round(pct(OLD_OK) * clamp(prog(s, CUE.oldPass, CUE.oldPass + 0.35) * 1.02));
  const newNum = Math.round(lerp(pct(OLD_OK), pct(NEW_OK), outExpo(prog(s, CUE.newWave[0], CUE.newPass))));
  return (
    <AbsoluteFill style={{ opacity: 1 - out, fontFamily: SANS }}>
      <AbsoluteFill style={{ opacity: 1 - dock, background: "radial-gradient(ellipse 60% 45% at 50% 44%, rgba(5,6,13,0.72) 0%, rgba(5,6,13,0.35) 60%, rgba(5,6,13,0) 100%)" }} />
      <AbsoluteFill style={{ opacity: dock, background: "linear-gradient(180deg, rgba(5,6,13,0.75) 0%, rgba(5,6,13,0) 30%)" }} />
      {/* Old: transcribe, then search. Slides left and shrinks when the new number lands. */}
      <div style={{ position: "absolute", left: lerp(lerp(960, 330, shift), 250, dock), top: lerp(lerp(470, 250, shift), 150, dock), transform: `translate(-50%, -50%) scale(${lerp(0.6, 1, clamp(oldIn)) * lerp(lerp(1, 0.42, shift), 0.4, dock)})`, textAlign: "center", opacity: clamp(oldIn * 1.5) * lerp(lerp(1, 0.75, shift), 1, dock) }}>
        <div style={{ fontSize: 300, fontWeight: 900, color: C.listen, letterSpacing: -12, lineHeight: 0.9, fontVariantNumeric: "tabular-nums", textShadow: `0 0 60px rgba(251,113,133,0.45)` }}>
          {oldNum}%
        </div>
        <div style={{ fontSize: 46, fontWeight: 700, color: "#ffd2d9", marginTop: 14 }}>transcribe, then search</div>
        <div style={{ position: "absolute", left: -20, right: -20, top: 150, height: 14, background: C.listen, borderRadius: 7, transformOrigin: "left center", transform: `scaleX(${outCubic(prog(s, CUE.newPass, CUE.newPass + 0.25))}) rotate(-8deg)`, boxShadow: `0 0 30px ${C.listen}` }} />
      </div>
      {/* New: pick from the card list. */}
      {s >= CUE.newWave[0] && (
        <div style={{ position: "absolute", left: lerp(960, 640, dock), top: lerp(480, 160, dock), transform: `translate(-50%, -50%) scale(${lerp(0.5, 1, clamp(newIn)) * lerp(1, 0.4, dock)})`, textAlign: "center", opacity: clamp(prog(s, CUE.newWave[0], CUE.newWave[0] + 0.15)) }}>
          <div style={{ fontSize: 400, fontWeight: 900, color: s >= CUE.newPass ? C.owned : "#9ff5cf", letterSpacing: -18, lineHeight: 0.9, fontVariantNumeric: "tabular-nums", textShadow: `0 0 ${80 + 60 * Math.exp(-(s - CUE.newPass) / 0.3)}px rgba(52,211,153,0.55)` }}>
            {newNum}%
          </div>
          <div style={{ fontSize: 54, fontWeight: 800, color: "#d7fff0", marginTop: 16, opacity: clamp((s - CUE.newPass) / 0.2) }}>pick from the card list</div>
        </div>
      )}
      {s >= CUE.disclosure && (
        <div style={{ position: "absolute", left: 90, right: 90, bottom: 44, fontFamily: MONO, fontSize: 21, lineHeight: 1.5, color: "#c3c8e4", opacity: clamp((s - CUE.disclosure) / 0.3), textAlign: "center", textShadow: "0 2px 12px rgba(0,0,0,0.9)" }}>
          {TOTAL} clips · 56 names × 4 synthetic macOS voices · {pct(OLD_OK)}% = Whisper base, transcribe→search ({OLD_OK}/{TOTAL})
          <br />{pct(NEW_OK)}% = small.en name scoring ({NEW_OK}/{TOTAL}) · small.en transcribe→search: 152/{TOTAL} · ~0.3 s per lookup on the Mac
          <br />not yet measured on the board's mic · which tiles pass at {pct(OLD_OK)}% is illustrative
        </div>
      )}
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
  const tag = spring(s, CUE.lockTag, 3, 0.5);
  const url = spring(s, CUE.lockUrl, 3, 0.5);
  return (
    <AbsoluteFill style={{ alignItems: "center", fontFamily: SANS }}>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,6,13,0.8) 0%, rgba(5,6,13,0.2) 42%, rgba(5,6,13,0) 60%)" }} />
      <div style={{ position: "absolute", top: 54, transform: `scale(${lerp(0.8, 1, clamp(k))})`, opacity: clamp(k * 1.5), filter: `blur(${(1 - clamp(k)) * 10}px)` }}>
        <Wordmark size={170} k={clamp(k)} />
      </div>
      <div style={{ position: "absolute", top: 250, fontSize: 52, fontWeight: 700, color: "#e6e2ff", opacity: clamp(tag * 1.4), transform: `translateY(${(1 - clamp(tag)) * 24}px)` }}>
        Say a card. <span style={{ color: C.amber }}>See the card.</span>
      </div>
      <div style={{ position: "absolute", bottom: 70, textAlign: "center", opacity: clamp(url * 1.4), transform: `translateY(${(1 - clamp(url)) * 20}px)` }}>
        <div style={{ fontFamily: MONO, fontSize: 36, fontWeight: 500, color: C.white }}>github.com/DidierRLopes/pokedex-esp32</div>
        <div style={{ fontSize: 24, fontWeight: 600, color: C.muted, marginTop: 12, letterSpacing: 1 }}>ESP32-S3 AMOLED · Whisper on your Mac · open source</div>
      </div>
    </AbsoluteFill>
  );
};

// The feed thumbnail: the product doing its job, with the name and tagline.
export const PosterType: React.FC = () => (
  <AbsoluteFill style={{ fontFamily: SANS }}>
    <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(5,6,13,0.85) 0%, rgba(5,6,13,0.4) 38%, rgba(5,6,13,0) 55%)" }} />
    <div style={{ position: "absolute", left: 90, top: 360 }}>
      <Wordmark size={124} />
      <div style={{ fontSize: 50, fontWeight: 700, color: "#e6e2ff", marginTop: 28 }}>
        Say a card.<br /><span style={{ color: C.amber }}>See the card.</span>
      </div>
    </div>
  </AbsoluteFill>
);

export { RESULTS, inCubic, outBack };

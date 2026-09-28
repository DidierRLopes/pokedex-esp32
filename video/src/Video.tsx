import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from "remotion";
import { CUE, FPS, PREROLL } from "./cues.ts";
import { W, H } from "./theme.ts";
import { clamp, inCubic, prog, shake } from "./anim.ts";
import { World } from "./world/World.tsx";
import { Headers, Lockup, PosterType, Spoken } from "./overlay/Type.tsx";
import { useReady } from "./useReady.ts";

// Song time s = video time − PREROLL. The pre-roll is the feed thumbnail:
// the board showing the printing you own, from its own fixed camera.
export const LaunchVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const s = frame / FPS - PREROLL;
  const ready = useReady();
  if (!ready) return null;

  const { x, y, r } = shake(s);
  const poster = s < 0;
  const posterOut = inCubic(prog(s, -0.02, 0.28));
  const flashes = [[CUE.result, 0.25], [CUE.owned, 0.3], [CUE.lockup, 0.25]].reduce((a, [t, g]) => a + (s >= t ? g * Math.exp(-(s - t) / 0.07) : 0), 0);
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#05060d" }}>
      <AbsoluteFill style={{ transform: `translate(${x}px, ${y}px) rotate(${r}deg) scale(1.03)` }}>
        <AbsoluteFill style={{ zIndex: 0, isolation: "isolate" }}>
          <World s={poster ? 0 : s} poster={poster} />
        </AbsoluteFill>
        <AbsoluteFill style={{ zIndex: 1, willChange: "transform", transform: "translateZ(0)" }}>
          {poster || posterOut < 1 ? (
            <AbsoluteFill style={{ transform: `scale(${1 + posterOut * 0.3})`, opacity: 1 - posterOut, filter: `blur(${posterOut * 14}px)` }}>
              <PosterType />
            </AbsoluteFill>
          ) : null}
          {!poster && (
            <>
              <Headers s={s} />
              <Spoken s={s} />
              <Lockup s={s} />
            </>
          )}
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#ffffff", opacity: clamp(flashes * 0.7), mixBlendMode: "screen" }} />
      <svg style={{ position: "absolute", inset: 0, mixBlendMode: "overlay", opacity: 0.16 }} width={W} height={H}>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 30} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width={W} height={H} filter="url(#grain)" />
      </svg>
      <Audio src={staticFile("soundtrack.wav")} />
    </AbsoluteFill>
  );
};

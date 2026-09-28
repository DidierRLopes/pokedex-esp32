import React from "react";
import { AbsoluteFill } from "remotion";
import { World } from "./world/World.tsx";
import { Proof } from "./overlay/Type.tsx";
import { useReady } from "./useReady.ts";

// The headline number's own still: the mosaic after the new pass.
const S = 24.2;
export const KeyArt: React.FC = () => {
  const ready = useReady();
  if (!ready) return null;
  return (
    <AbsoluteFill style={{ background: "#05060d" }}>
      <World s={S} />
      <Proof s={S} />
    </AbsoluteFill>
  );
};

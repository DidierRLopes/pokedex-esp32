import React from "react";
import { Composition } from "remotion";
import { DURATION, FPS } from "./cues.ts";
import { H, W } from "./theme.ts";
import { LaunchVideo } from "./Video.tsx";

export const Root: React.FC = () => (
  <Composition id="LaunchVideo" component={LaunchVideo} durationInFrames={Math.round(DURATION * FPS)} fps={FPS} width={W} height={H} />
);

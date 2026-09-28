import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { fontsReady } from "./theme.ts";
import { loadBall } from "./world/textures.ts";

// Fonts and the Poké Ball sprite must be ready before any canvas draws.
export function useReady() {
  const [handle] = useState(() => delayRender("assets"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([fontsReady, loadBall(staticFile("pokeball.png"))]).then(() => {
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready;
}

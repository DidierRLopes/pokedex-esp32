import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { fontsReady } from "./theme.ts";
import { IMAGES } from "./data.ts";

// Loaded images by public path; canvases draw from these synchronously.
export const images = new Map<string, HTMLImageElement>();

const load = (path: string) =>
  images.has(path)
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          images.set(path, img);
          resolve();
        };
        img.onerror = reject;
        img.src = staticFile(path);
      });

// Fonts and every capture must be ready before any canvas draws.
export function useReady() {
  const [handle] = useState(() => delayRender("assets"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([fontsReady, ...IMAGES.map(load)]).then(() => {
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready;
}

// The lens: ambient occlusion, depth of field, bloom, chromatic aberration,
// tone mapping, vignette and grain, all driven by song time. Built
// imperatively and rendered from our own frame callback, because Remotion
// advances R3F manually and a React-assembled composer draws nothing.
import { useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BlendFunction, BloomEffect, ChromaticAberrationEffect, DepthOfFieldEffect, EffectComposer, EffectPass,
  NoiseEffect, RenderPass, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { CUE } from "../cues.ts";
import { hit, kick, lerp, prog } from "../anim.ts";
import { cameraAt } from "./camera.ts";
import { BOARD_POS } from "./layout.ts";
import { H, W } from "../theme.ts";

export const Post: React.FC<{ s: number; poster: boolean }> = ({ s, poster }) => {
  const { gl, scene, camera } = useThree();
  const fx = useMemo(() => {
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(scene, camera));
    const ao = new N8AOPostPass(scene, camera, W, H);
    ao.configuration.aoRadius = 0.8;
    ao.configuration.distanceFalloff = 0.8;
    ao.configuration.intensity = 2.2;
    ao.configuration.halfRes = true;
    ao.setQualityMode("High");
    composer.addPass(ao);
    const dof = new DepthOfFieldEffect(camera, { focalLength: 0.02, bokehScale: 0, height: 540 });
    const bloom = new BloomEffect({ mipmapBlur: true, intensity: 1, luminanceThreshold: 0.85, luminanceSmoothing: 0.2, radius: 0.7 });
    const ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(), radialModulation: true, modulationOffset: 0.35 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.55 });
    const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SOFT_LIGHT });
    noise.blendMode.opacity.value = 0.12;
    // DOF gets its own pass; chromatic aberration must not share one with convolution effects.
    composer.addPass(new EffectPass(camera, dof));
    composer.addPass(new EffectPass(camera, bloom));
    composer.addPass(new EffectPass(camera, ca, tone, vignette, noise));
    composer.setSize(W, H);
    return { composer, dof, bloom, ca };
  }, [gl, scene, camera]);

  const h = hit(s);
  const { look, pos } = cameraAt(s, poster);
  // Focus where the story is: the board, then the card beside it, then the fan.
  const focus = poster ? BOARD_POS.clone() : new THREE.Vector3(look[0], look[1], look[2]);
  fx.dof.target = focus;
  const dist = Math.hypot(pos[0] - focus.x, pos[1] - focus.y, pos[2] - focus.z);
  // Deep focus for the wide shots: the fan and the route home.
  const wide = Math.max(prog(s, CUE.fan, CUE.fan + 1), prog(s, CUE.atPhone, CUE.launch) * (1 - prog(s, CUE.reply + 0.8, CUE.backOnBoard))) * (poster ? 0 : 1);
  fx.dof.bokehScale = lerp(1.8, 0.5, prog(dist, 9, 22)) * (1 - wide * 0.6);
  fx.bloom.intensity = 0.8 + h * 0.6 + kick(s) * 0.12;
  const ca = 0.0005 + h * 0.003 + kick(s) * 0.0003;
  fx.ca.offset.set(ca, ca * 0.6);

  useFrame(() => {
    fx.composer.render();
  }, 1);
  return null;
};

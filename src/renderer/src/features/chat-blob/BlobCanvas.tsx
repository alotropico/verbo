/* eslint react/no-unknown-property: "off" -- React Three Fiber JSX uses Three.js properties. */
import {
  Environment,
  Float,
  Lightformer,
  MeshDistortMaterial,
} from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useSyncExternalStore, type ReactNode } from "react";
import { ACESFilmicToneMapping } from "three";

import styles from "./ChatBlob.module.css";

const motionQuery = "(prefers-reduced-motion: reduce)";

function subscribeMotionPreference(onChange: () => void): () => void {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getReducedMotion(): boolean {
  return window.matchMedia(motionQuery).matches;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getVisible(): boolean {
  return document.visibilityState !== "hidden";
}

function getServerSnapshot(): boolean {
  return true;
}

export default function BlobCanvas(): ReactNode {
  const reducedMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getReducedMotion,
    getServerSnapshot,
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    getVisible,
    getServerSnapshot,
  );

  return (
    <Canvas
      camera={{ position: [0, 0, 4], fov: 35, near: 0.1, far: 20 }}
      className={styles.canvas}
      dpr={[1, 2]}
      fallback={<div className={styles.fallback} />}
      frameloop={!visible ? "never" : reducedMotion ? "demand" : "always"}
      gl={{ alpha: true, antialias: true, toneMapping: ACESFilmicToneMapping }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <Environment resolution={64}>
        <Lightformer intensity={3} position={[-3, 3, 4]} scale={[3, 5, 1]} />
        <Lightformer intensity={2} position={[3, -2, 2]} scale={[2, 4, 1]} />
        <Lightformer intensity={1.5} position={[0, 4, -3]} scale={3} />
      </Environment>
      <Float
        speed={reducedMotion ? 0 : 1.2}
        rotationIntensity={0.35}
        floatIntensity={0.3}
        floatingRange={[-0.12, 0.12]}
      >
        <mesh rotation={[0.3, -0.4, -0.2]}>
          <sphereGeometry args={[1, 64, 64]} />
          <MeshDistortMaterial
            color="#9ce5c6"
            distort={0.45}
            speed={reducedMotion ? 0 : 1.2}
            roughness={0.22}
            metalness={0.35}
            clearcoat={1}
            clearcoatRoughness={0.15}
          />
        </mesh>
      </Float>
    </Canvas>
  );
}

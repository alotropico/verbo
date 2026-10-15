# Chat blob

The only public entry point is `index.tsx`:

```tsx
import { ChatBlob } from "./features/chat-blob";

<ChatBlob />;
```

To migrate it, copy this entire folder into another React app with CSS module
support and install `three`, `@react-three/fiber` (v9 for React 19),
`@react-three/drei`, and the development dependency `@types/three`.

The feature owns its 60 × 60 px size, styling, mint material, procedural lighting,
and animation. It uses only relative imports and needs no state store, providers,
IPC, downloaded textures, or external assets. Its CSS fallback reads
`--orb-highlight`, `--orb-tint`, and `--orb-shadow` from the host's semantic theme
in `assets/globals.css`. When migrating this folder, provide those three color
tokens in the destination theme as well.
It renders as an inline-block aligned to the middle of surrounding text. The host
decides placement; the component includes a 5 px inline margin.

The 3D module loads lazily. Reduced motion keeps a still scene; hidden documents
pause rendering. Loading or unavailable WebGL uses a static CSS blob. Unmounting
the feature releases the canvas and scene resources through React Three Fiber.

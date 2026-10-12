# Chat blob

The only public entry point is `index.tsx`:

```tsx
import { ChatBlob } from "./features/chat-blob";

<ChatBlob />;
```

To migrate it, copy this entire folder into another React app with CSS module
support and install `three`, `@react-three/fiber` (v9 for React 19),
`@react-three/drei`, and the development dependency `@types/three`.

The feature owns its 70 × 70 px size, styling, mint material, procedural lighting,
and animation. It uses only relative imports: no app theme, CSS tokens, state
store, providers, IPC, downloaded textures, or external assets are required.
It renders as an inline-block aligned to the middle of surrounding text. The host
decides placement and spacing.

The 3D module loads lazily. Reduced motion keeps a still scene; hidden documents
pause rendering. Loading or unavailable WebGL uses a static CSS blob. Unmounting
the feature releases the canvas and scene resources through React Three Fiber.

# App icons

The vector geometry lives in `src/renderer/src/assets/verbo-mark.json` and is also used by the in-app `VerboMark` component. Native icon colors come from the dark theme's `--primary` and `--card` tokens in `globals.css`.

Run `npm run icons:generate` after changing the mark or its colors. It recreates the SVG, 1024px PNG, Windows ICO, macOS ICNS, Linux PNG sizes, and renderer favicon with electron-builder's icon converter. The converter is cached after its first download.

Keep these generated assets checked in so ordinary packaging can use them without running the converter. Electron uses the icons in `build/` during development and the copies in `resources/icons/` when packaged.

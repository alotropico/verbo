# App icons

The vector geometry lives in `src/renderer/src/assets/verbo-mark.json` and is also used by the in-app `VerboMark` component. The mark and wordmark dot use the dedicated `--brand` token in `globals.css`; native icon backgrounds use the dark theme's `--card` token. Branding colors are independent of the app's accent colors.

Run `npm run icons:generate` after changing the mark or its colors. It recreates the SVG, 1024px PNG, Windows ICO, macOS ICNS, Linux PNG sizes, and renderer favicon with electron-builder's icon converter. The converter is cached after its first download.

Keep these generated assets checked in so ordinary packaging can use them without running the converter. Electron uses the icons in `build/` during development and the copies in `resources/icons/` when packaged.

`replies/` contains Windows ICO variants with a small top-right status dot: blue for a question or confirmation, green for success, red for an error or abort, and yellow for partial completion. They use existing theme chart/status colors. The app retains unread status across restarts and restores the ordinary icon after the relevant chats are viewed, archived, or deleted. A complete icon variant is necessary because Windows fixes native overlays to the bottom right.

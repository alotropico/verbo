import { discoverApplicationCandidates } from "./application-candidates";

try {
  process.parentPort?.postMessage({
    ok: true,
    candidates: discoverApplicationCandidates(),
  });
} catch (cause) {
  process.parentPort?.postMessage({
    ok: false,
    error:
      cause instanceof Error
        ? cause.message
        : "Available programs could not be detected.",
  });
}

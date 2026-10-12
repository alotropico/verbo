import { createVoiceSupervisor } from "./voice-supervisor.mjs";

const voice = createVoiceSupervisor({ stdio: "inherit" });

const state = await voice.ensure();
console.log(state.detail);
if (state.mode !== "started")
  process.exit(state.mode === "unavailable" ? 1 : 0);

const shutdown = (code) => {
  voice.stopOwned();
  process.exit(code ?? 0);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
state.child.on("exit", (code) => {
  process.exit(code ?? 0);
});

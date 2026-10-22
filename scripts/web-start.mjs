import { createWebSupervisor } from "./web-supervisor.mjs";

const web = createWebSupervisor({ stdio: "inherit" });

const state = await web.ensure();
console.log(state.detail);

if (state.mode === "unavailable") {
  process.exit(1);
}

if (state.mode === "adopted" || state.mode === "reused") {
  process.exit(0);
}

if (state.mode === "started" && state.child) {
  const shutdown = (code) => {
    web.stopOwned();
    process.exit(code ?? 0);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  state.child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

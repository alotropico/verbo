// Deliberately excludes Electron, Puppeteer and Verbo's registry: transport tests
// exercise actual child-process stdio without depending on Chromium or the network.
import readline from "node:readline";
import { spawn } from "node:child_process";
const jobs = new Map();
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line);
    if (request.op === "close") process.exit(0);
    if (request.op === "cancel") {
      clearTimeout(jobs.get(request.targetId));
      jobs.delete(request.targetId);
      reply({ id: request.targetId, ok: false, code: "cancelled" });
      return;
    }
    if (request.query === "crash") process.exit(9);
    if (request.query === "protocol") {
      process.stdout.write("invalid-json\n");
      return;
    }
    if (request.query === "hang") return;
    if (request.query === "descendant") {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
      child.unref();
      reply({
        id: request.id,
        ok: true,
        value: {
          outcome: "ok",
          results: [
            {
              title: String(child.pid),
              url: "https://example.com/",
              engine: request.engine,
              rank: 1,
            },
          ],
        },
      });
      return;
    }
    const done = () =>
      reply({
        id: request.id,
        ok: true,
        value: {
          outcome: "ok",
          results: [
            {
              title: String(process.pid),
              url: "https://example.com/",
              engine: request.engine,
              rank: 1,
            },
          ],
        },
      });
    if (request.query === "slow") jobs.set(request.id, setTimeout(done, 300));
    else done();
  })
  .on("close", () => process.exit(0));

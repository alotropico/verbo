import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "./process";
import { execFileAgs } from "../ags/check";
import { agsExecutableIdentity, agsProcessInvocation } from "../ags/executable";

describe("bounded native process execution", () => {
  it("limits output and settles timeouts, cancellation and spawn failure", async () => {
    const base = {
      executable: process.execPath,
      cwd: process.cwd(),
      timeoutMs: 5000,
    };
    const output = await runBoundedProcess({
      ...base,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(100000));process.stderr.write('y'.repeat(100000))",
      ],
    });
    expect(output).toMatchObject({ code: 0, spawned: true, timedOut: false });
    expect(output.stdout).toHaveLength(65536);
    expect(output.stderr).toHaveLength(65536);
    const timeout = await runBoundedProcess({
      ...base,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 200,
    });
    expect(timeout).toMatchObject({ timedOut: true, spawned: true });
    const controller = new AbortController();
    const pending = runBoundedProcess({
      ...base,
      args: ["-e", "setInterval(()=>{},1000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ cancelled: true });
    expect(
      await runBoundedProcess({
        ...base,
        executable: join(process.cwd(), "missing-program.exe"),
        args: [],
      }),
    ).toMatchObject({ spawned: false, code: null });
    controller.abort();
    expect(
      await runBoundedProcess({ ...base, args: [], signal: controller.signal }),
    ).toMatchObject({ cancelled: true, spawned: false });
  });

  it.runIf(process.platform === "win32")(
    "runs only the fixed AGS cmd shim, including a path with spaces",
    async () => {
      const tempRoot = realpathSync(tmpdir());
      const directory = mkdtempSync(join(tempRoot, "verbo ags adapter "));
      try {
        const executable = join(directory, "ags.cmd");
        writeFileSync(
          executable,
          '@echo off\r\nif "%~1"=="check" echo fixed-check\r\n',
        );
        const identity = agsExecutableIdentity(executable);
        const result = await execFileAgs({
          executable,
          args: ["check"],
          cwd: directory,
          timeoutMs: 5000,
        });
        expect(result).toMatchObject({ code: 0, timedOut: false });
        expect(result.stdout.trim()).toBe("fixed-check");
        await expect(
          execFileAgs({
            executable,
            args: ["check", "& calc.exe"],
            cwd: directory,
            timeoutMs: 5000,
          }),
        ).rejects.toThrow("fixed check");
        expect(() =>
          agsProcessInvocation(join(directory, "bad%PATH%", "ags.cmd")),
        ).toThrow("unsafe");
        writeFileSync(executable, "@echo changed\r\n");
        expect(agsExecutableIdentity(executable)).not.toBe(identity);
      } finally {
        const target = realpathSync(directory);
        const boundary = relative(tempRoot, target);
        expect(
          Boolean(boundary) &&
            !boundary.startsWith("..") &&
            !isAbsolute(boundary),
        ).toBe(true);
        rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 25,
        });
      }
    },
  );
});

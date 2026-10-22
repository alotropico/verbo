import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ entry: "", marker: "" }));
vi.mock("./runtime", () => ({ aloRuntime: () => ({ node: process.execPath, entry: fixture.entry, profile: ":memory:" }) }));
import { aloCall, withAloSignal } from "./client";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "verbo-async-alo-"));
  fixture.entry = join(directory, "fixture.cjs");
  fixture.marker = join(directory, "started.txt");
  writeFileSync(
    fixture.entry,
    `
    let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>input+=chunk);
    process.stdin.on('end',()=>{
      const request=JSON.parse(input);
      require('node:fs').writeFileSync(request.args.marker,String(process.pid));
      if(request.args.mode==='hang') { setInterval(()=>{},1000); return; }
      if(request.args.mode==='oversized') { process.stdout.write('x'.repeat(2*1024*1024+1)); setInterval(()=>{},1000); return; }
      setTimeout(()=>process.stdout.write(JSON.stringify({version:1,id:request.args.mode==='wrong-id'?'other':request.id,ok:true,result:{value:'fixture'}}),()=>process.exit(0)),150);
    });
  `,
  );
});
afterEach(() => {
  expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
const request = (mode = "normal"): Parameters<typeof aloCall>[0] => ({
  method: "catalog",
  args: { mode, marker: fixture.marker },
  context: { actor: "ui", threadId: "fixture" },
});
const started = async (): Promise<number> => {
  await vi.waitFor(() => expect(existsSync(fixture.marker)).toBe(true));
  return Number(readFileSync(fixture.marker, "utf8"));
};
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

describe("asynchronous Alo subprocess lifecycle", () => {
  it("allows the event loop to handle other work while waiting for a response", async () => {
    const pending = aloCall(request());
    let timerRan = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0),
    );
    expect(timerRan).toBe(true);
    expect(await pending).toEqual({ value: "fixture" });
  });
  it("cancels an in-flight child and settles after the child exits", async () => {
    const controller = new AbortController();
    const pending = aloCall(request("hang"), controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "cancelled", dispatched: true });
    const pid = await started();
    controller.abort();
    await assertion;
    expect(exited(pid)).toBe(true);
  });
  it("does not spawn for a pre-cancelled request", async () => {
    await expect(aloCall(request(), AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled", dispatched: false });
    expect(existsSync(fixture.marker)).toBe(false);
  });
  it("inherits turn cancellation and keeps unrelated requests independent", async () => {
    const controller = new AbortController();
    const pending = withAloSignal(controller.signal, () => aloCall(request("hang")));
    const assertion = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const pid = await started();
    controller.abort();
    await assertion;
    expect(exited(pid)).toBe(true);
    await expect(aloCall(request())).resolves.toEqual({ value: "fixture" });
    await expect(withAloSignal(controller.signal, () => withAloSignal(undefined, () => aloCall(request())))).resolves.toEqual({
      value: "fixture",
    });
  });
  it("terminates a child which exceeds the response size bound", async () => {
    const pending = aloCall(request("oversized"));
    const assertion = expect(pending).rejects.toThrow("exceeds its bound");
    const pid = await started();
    await assertion;
    expect(exited(pid)).toBe(true);
  });
  it("rejects a response belonging to another request", async () => {
    await expect(aloCall(request("wrong-id"))).rejects.toThrow("identity mismatch");
  });
  it("kills a stalled catalog child on timeout", async () => {
    const pending = aloCall(request("hang"));
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout", dispatched: true });
    const pid = await started();
    await assertion;
    expect(exited(pid)).toBe(true);
  }, 15000);
});

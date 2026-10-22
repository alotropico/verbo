import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import { DatabaseSync } from "node:sqlite";
vi.mock("./client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./client")>()), aloCall: vi.fn() }));
import { aloCall, AloCallError } from "./client";
import { createAloRegistry } from "./registry";
import { createInvocationPolicy } from "../agents/policy";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { decideOperation } from "../files/mutation-plan";

afterEach(() => vi.mocked(aloCall).mockReset());
const admission = { ok: true, name: "files.create", args: { path: "notes:/draft.md", kind: "file", content: "Body" }, kind: "mutation" };
const context = { actor: "user_command" as const, threadId: "fixture" };
describe("async Alo command admission", () => {
  it.each([
    ["cancelled", false, "cancelled", "cancelled"],
    ["unavailable", false, "error", "alo_unavailable"],
    ["cancelled", true, "partial", "effect_uncertain"],
  ] as const)("settles approval failure %s (dispatched=%s) without retrying", async (code, dispatched, status, resultCode) => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, VERBO_MIGRATIONS);
      vi.mocked(aloCall).mockRejectedValueOnce(new AloCallError("Fixture failure", code, dispatched));
      expect(await decideOperation({ database, operationId: "operation", threadId: "thread", decision: "approve" })).toMatchObject({
        status,
        code: resultCode,
      });
      expect(aloCall).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });
  it("constructs without IO and obtains a fresh catalog on every lookup", async () => {
    const registry = createAloRegistry();
    expect(aloCall).not.toHaveBeenCalled();
    vi.mocked(aloCall).mockResolvedValueOnce({ ok: true, id: "files.read" }).mockResolvedValueOnce({ ok: true, id: "files.edit" });
    expect(await registry.resolve("files.custom")).toEqual({ ok: true, id: "files.read" });
    expect(await registry.resolve("files.custom")).toEqual({ ok: true, id: "files.edit" });
    expect(aloCall).toHaveBeenCalledTimes(2);
  });
  it("cancels pending admission without dispatching the action", async () => {
    const controller = new AbortController();
    vi.mocked(aloCall).mockImplementationOnce(
      (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new AloCallError("Cancelled", "cancelled", true)), { once: true }),
        ),
    );
    const pending = createAloRegistry().invoke("files.create", admission.args, { ...context, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(aloCall).toHaveBeenCalledOnce();
  });
  it("preserves a denied admission without invoking the command", async () => {
    vi.mocked(aloCall).mockResolvedValueOnce({
      ok: false,
      result: { action: "files.create", status: "denied", code: "write_denied", summary: "Read-only folder" },
    });
    expect(await createAloRegistry().invoke("files.create", admission.args, context)).toMatchObject({
      status: "denied",
      code: "write_denied",
    });
    expect(aloCall).toHaveBeenCalledOnce();
  });
  it("retains uncertainty when a dispatched mutation is interrupted", async () => {
    vi.mocked(aloCall)
      .mockResolvedValueOnce(admission)
      .mockRejectedValueOnce(new AloCallError("Cancelled", "cancelled", true));
    const result = await createAloRegistry().invoke("files.create", admission.args, context);
    expect(result).toMatchObject({ status: "partial", code: "effect_uncertain" });
    expect(aloCall).toHaveBeenCalledTimes(2);
  });
  it("awaits ledger admission and records cancellation before dispatch without uncertainty", async () => {
    const controller = new AbortController();
    const after = vi.fn();
    const invocation = createInvocationPolicy({
      id: "fixture",
      agentId: "commander",
      exposed: true,
      forbidden: [],
      allowed: { modules: ["files"], actions: [] },
      discoverable: { modules: ["files"], actions: [] },
      ledger: {
        before: async () => {
          await Promise.resolve();
          controller.abort();
          return { id: "attempt", receiptId: "receipt" };
        },
        after,
      },
    });
    vi.mocked(aloCall)
      .mockResolvedValueOnce(admission)
      .mockImplementationOnce(async (_input, signal) => {
        expect(signal?.aborted).toBe(true);
        throw new AloCallError("Cancelled before dispatch", "cancelled", false);
      });
    const result: ActionResult = await createAloRegistry().invoke("files.create", admission.args, {
      ...context,
      signal: controller.signal,
      invocation,
    });
    expect(result).toMatchObject({ status: "cancelled", code: "cancelled", receiptId: "receipt" });
    expect(after).toHaveBeenCalledWith({ id: "attempt", receiptId: "receipt" }, result);
  });
});

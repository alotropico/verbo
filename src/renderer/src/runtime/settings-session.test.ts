import { describe, expect, it } from "vitest";
import { SettingsSession } from "./settings-session";

describe("settings session ownership", () => {
  it("retains an invalid draft after its view unsubscribes and restores it on return", () => {
    const session = new SettingsSession();
    const draft = session.cell("folder/one/draft", { alias: "folder" });
    let notifications = 0;
    const unsubscribe = draft.subscribe(() => {
      notifications++;
    });
    draft.set({ alias: "unfinished alias!" });
    unsubscribe();
    draft.set({ alias: "still invalid!" });
    expect(notifications).toBe(1);
    expect(
      session.cell("folder/one/draft", { alias: "server" }).snapshot(),
    ).toEqual({ alias: "still invalid!" });
  });

  it("keeps one canonical autosave across views and retains failed writes for retry", async () => {
    const session = new SettingsSession();
    let fail = true;
    const saved: string[][] = [];
    const save = async (aliases: string[]): Promise<void> => {
      if (fail) throw new Error("offline");
      saved.push(aliases);
    };
    const general = session.autosave("command-alias/web/save", save);
    general.controller.schedule(["find"]);
    await general.controller.flush();
    const module = session.autosave("command-alias/web/save", save);
    expect(module.controller).toBe(general.controller);
    expect(module.state.snapshot()).toEqual({
      status: "error",
      error: "offline",
    });
    fail = false;
    module.controller.retry();
    await session.flush();
    expect(saved).toEqual([["find"]]);
  });

  it("finishes a write after its view leaves and resets pending drafts before restoring defaults", async () => {
    const session = new SettingsSession();
    let release: (() => void) | undefined;
    const saved: string[] = [];
    const save = session.autosave("web/save", async (value: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      saved.push(value);
    });
    save.controller.schedule("first");
    const flushing = session.flush();
    save.controller.schedule("obsolete");
    const reset = session.resetAutosaves("web/");
    release?.();
    await Promise.all([flushing, reset]);
    expect(saved).toEqual(["first"]);
    session.cell("web/draft", "dirty");
    session.cell("model/draft", "retain");
    session.clear("web/");
    expect(session.cell("web/draft", "defaults").snapshot()).toBe("defaults");
    expect(session.cell("model/draft", "other").snapshot()).toBe("retain");
    expect(
      session.autosave("web/save", async () => undefined).state.snapshot()
        .status,
    ).toBe("idle");
  });

  it("reports successful writes only, including after a view reconfigures the controller", async () => {
    let saves = 0;
    const session = new SettingsSession(() => saves++);
    let fail = true;
    const save = async (): Promise<void> => {
      if (fail) throw new Error("offline");
    };
    const entry = session.autosave("web/save", save);
    entry.controller.schedule("first");
    await entry.controller.flush();
    expect(saves).toBe(0);
    fail = false;
    entry.controller.configure(save, entry.notify);
    entry.controller.retry();
    await entry.controller.flush();
    expect(saves).toBe(1);
  });
});

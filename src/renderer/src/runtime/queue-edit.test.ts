import { afterEach, describe, expect, it } from "vitest";
import {
  clearQueueEdit,
  getQueueEdit,
  keepQueueComposerRestore,
  setQueueEdit,
  takeQueueComposerRestore,
} from "./queue-edit";

const edit = {
  id: "queued-item",
  threadId: "chat-a",
  token: "lease-one",
  revision: 1,
  attachmentRefs: [],
};
afterEach(() => setQueueEdit(null));
describe("queued composer edit ownership", () => {
  it("never exposes another chat's lease when switching composers", () => {
    setQueueEdit(edit);
    expect(getQueueEdit("chat-a")).toBe(edit);
    expect(getQueueEdit("chat-b")).toBe(null);
    expect(getQueueEdit("chat-a")).toBe(edit);
  });
  it("does not let a late completion clear a newer lease", () => {
    setQueueEdit({ ...edit, token: "lease-two" });
    clearQueueEdit(edit);
    expect(getQueueEdit("chat-a")?.token).toBe("lease-two");
    clearQueueEdit({ ...edit, token: "lease-two" });
    expect(getQueueEdit("chat-a")).toBe(null);
  });
  it("restores a buffered typed draft only in its owning chat, once", () => {
    keepQueueComposerRestore("chat-a", "Original typed draft");
    expect(takeQueueComposerRestore("chat-b")).toBeUndefined();
    expect(takeQueueComposerRestore("chat-a")).toBe("Original typed draft");
    expect(takeQueueComposerRestore("chat-a")).toBeUndefined();
    keepQueueComposerRestore("chat-a", "");
    expect(takeQueueComposerRestore("chat-a")).toBe("");
  });
});

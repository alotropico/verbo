import { describe, expect, it } from "vitest";
import { savedRemoteThreadId } from "./thread-identity";

describe("saved remote thread id", () => {
  it("treats a new chat as unsaved even when its local id looks real", () => {
    expect(
      savedRemoteThreadId({
        status: "new",
        remoteId: undefined,
      }),
    ).toBeNull();
    expect(
      savedRemoteThreadId({
        status: "new",
        remoteId: "__LOCALID_draft",
      }),
    ).toBeNull();
  });

  it("returns the remote id once the chat is stored", () => {
    expect(
      savedRemoteThreadId({
        status: "regular",
        remoteId: "__LOCALID_draft",
      }),
    ).toBe("__LOCALID_draft");
    expect(
      savedRemoteThreadId({
        status: "archived",
        remoteId: "thread-notes",
      }),
    ).toBe("thread-notes");
  });
});

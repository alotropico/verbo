import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReplyAttentionStore } from "./reply-attention-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "verbo-reply-state-"));
  directories.push(directory);
  return join(directory, "reply-attention.json");
}
it("retains unread outcomes across restarts and persists reading them", () => {
  const path = fixture();
  const store = createReplyAttentionStore(path);
  expect(store.load()).toEqual([]);
  const replies = [{ turnId: "turn", threadId: "chat", state: "question" as const }];
  store.save(replies);
  expect(createReplyAttentionStore(path).load()).toEqual(replies);
  store.save([]);
  expect(createReplyAttentionStore(path).load()).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
});
it("ignores missing or malformed state and does not block delivery on write failures", () => {
  const path = fixture();
  for (const content of ["{", JSON.stringify([{ turnId: "turn", threadId: "chat", state: "invalid" }])]) {
    writeFileSync(path, content);
    expect(createReplyAttentionStore(path).load()).toEqual([]);
  }
  const blocked = join(path, "child.json");
  expect(() => createReplyAttentionStore(blocked).save([])).not.toThrow();
  const nested = join(path + "-directory", "state.json");
  mkdirSync(path + "-directory");
  createReplyAttentionStore(nested).save([]);
  expect(createReplyAttentionStore(nested).load()).toEqual([]);
});

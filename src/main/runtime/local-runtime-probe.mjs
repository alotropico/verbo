import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const reactEntry = require.resolve("@assistant-ui/react");
const coreEntry = createRequire(reactEntry).resolve("@assistant-ui/core");
const file = `${coreEntry.slice(0, coreEntry.lastIndexOf("index.js"))}runtimes/local/local-runtime-core.js`;
const { LocalRuntimeCore } = await import(pathToFileURL(file).href);

function userMessage(text, parentId = null, steer) {
  return {
    parentId,
    sourceId: null,
    runConfig: {},
    role: "user",
    content: [{ type: "text", text }],
    attachments: [],
    metadata: { custom: {} },
    createdAt: new Date(),
    ...(steer !== undefined ? { steer } : {}),
  };
}

function tailId(thread) {
  return thread.messages.at(-1)?.id ?? null;
}

function createThread(run, humanToolNames) {
  const core = new LocalRuntimeCore(
    {
      adapters: { chatModel: { run } },
      unstable_enableMessageQueue: true,
      unstable_humanToolNames: humanToolNames ?? [
        "capabilities.list",
        "capabilities.describe",
        "actions.invoke",
      ],
    },
    undefined,
  );
  return core.threads.getMainThreadRuntimeCore();
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const evidence = {};

{
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const thread = createThread(async function* run() {
    yield { content: [{ type: "text", text: "partial" }] };
    await gate;
    yield { content: [{ type: "text", text: "done" }] };
  });
  const first = thread.append(userMessage("one"));
  await withTimeout(
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (
          thread.messages.some((message) =>
            message.content.some((part) => part.text === "partial"),
          )
        ) {
          resolve();
          return;
        }
        if (Date.now() - started > 2000) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    }),
    2500,
    "partial",
  );
  const second = await withTimeout(
    thread.append(userMessage("two", tailId(thread))),
    1000,
    "steer append",
  );
  evidence.steerDuringRun = {
    steer: thread.getSteerQueueItems().map((item) => item.prompt),
    queue: thread.getQueueItems().map((item) => item.prompt),
    secondSettled: second === undefined,
  };
  release();
  await withTimeout(first, 2000, "first run");
}

{
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const thread = createThread(async function* run() {
    runs += 1;
    yield { content: [{ type: "text", text: `run-${runs}` }] };
    if (runs === 1) await gate;
  });
  const first = thread.append(userMessage("one"));
  await withTimeout(
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (runs >= 1) resolve();
        else if (Date.now() - started > 2000) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    }),
    2500,
    "first busy",
  );
  await withTimeout(
    thread.append(userMessage("two", tailId(thread), false)),
    1000,
    "queue append",
  );
  const queued = thread.getQueueItems().map((item) => item.prompt);
  const runsBeforeRelease = runs;
  release();
  await withTimeout(first, 2000, "queued first");
  await withTimeout(
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (runs >= 2) resolve();
        else if (Date.now() - started > 2000) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    }),
    2500,
    "second dispatch",
  );
  evidence.queueLaneDispatchesItself = {
    queued,
    runsBeforeRelease,
    runsAfterIdle: runs,
  };
}

{
  let runs = 0;
  const thread = createThread(
    async function* run() {
      runs += 1;
      yield {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "capabilities.list",
            args: { path: "files" },
          },
        ],
        status: { type: "requires-action", reason: "tool-calls" },
      };
    },
    ["capabilities.list"],
  );
  await withTimeout(
    thread.append(userMessage("list files")),
    2000,
    "human tool",
  );
  evidence.unresolvedHumanTool = { runs };
}

{
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const thread = createThread(async function* run() {
    runs += 1;
    yield {
      content: [
        { type: "text", text: "Checking" },
        {
          type: "tool-call",
          toolCallId: "call-approve",
          toolName: "actions.invoke",
          args: { name: "files.create" },
          approval: { id: "approval-1" },
        },
      ],
      status: { type: "requires-action", reason: "tool-calls" },
    };
    await gate;
    yield { content: [{ type: "text", text: "Created note.md" }] };
  });
  const pending = thread.append(userMessage("create a note"));
  await withTimeout(
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const status = thread.messages.at(-1)?.status?.type;
        if (status === "requires-action") resolve();
        else if (Date.now() - started > 2000) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    }),
    2500,
    "approval pause",
  );
  const pausedRuns = runs;
  const pausedStatus = thread.messages.at(-1)?.status?.type;
  release();
  await withTimeout(pending, 2000, "approval resume");
  evidence.approvalStaysInOneRun = {
    pausedRuns,
    pausedStatus,
    runs,
    finished:
      thread.messages
        .at(-1)
        ?.content?.some((part) => part.text === "Created note.md") === true,
  };
}

const failures = [];
if (
  evidence.steerDuringRun.steer.join() !== "two" ||
  evidence.steerDuringRun.queue.length !== 0
) {
  failures.push("steer");
}
if (
  evidence.queueLaneDispatchesItself.queued.join() !== "two" ||
  evidence.queueLaneDispatchesItself.runsBeforeRelease !== 1 ||
  evidence.queueLaneDispatchesItself.runsAfterIdle !== 2
) {
  failures.push("queue-owner");
}
if (evidence.unresolvedHumanTool.runs !== 1) failures.push("human-tool");
if (
  evidence.approvalStaysInOneRun.pausedRuns !== 1 ||
  evidence.approvalStaysInOneRun.runs !== 1 ||
  evidence.approvalStaysInOneRun.pausedStatus !== "requires-action" ||
  evidence.approvalStaysInOneRun.finished !== true
) {
  failures.push("approval");
}

console.log(JSON.stringify({ evidence, failures }));
process.exit(failures.length > 0 ? 1 : 0);

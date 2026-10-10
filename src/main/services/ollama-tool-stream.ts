export type AggregatedToolCall = {
  index: number;
  id: string;
  name: string;
  arguments: unknown;
};

export type AggregatedOllamaStream = {
  content: string;
  thinking: string;
  toolCalls: AggregatedToolCall[];
  done: boolean;
  doneReason?: string;
  promptEvalCount?: number;
  evalCount?: number;
  malformed: number;
};

type ToolAccumulator = {
  index: number;
  id: string;
  name: string;
  argumentText: string;
  argumentObject?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function aggregateOllamaToolStream(
  chunks: readonly unknown[],
): AggregatedOllamaStream {
  let content = "";
  let thinking = "";
  let done = false;
  let doneReason: string | undefined;
  let promptEvalCount: number | undefined;
  let evalCount: number | undefined;
  let malformed = 0;
  const tools = new Map<number, ToolAccumulator>();

  for (const chunk of chunks) {
    if (!isRecord(chunk) || chunk.parseError === true) {
      malformed += 1;
      continue;
    }
    if (chunk.done === true) done = true;
    if (typeof chunk.done_reason === "string") doneReason = chunk.done_reason;
    if (typeof chunk.prompt_eval_count === "number")
      promptEvalCount = chunk.prompt_eval_count;
    if (typeof chunk.eval_count === "number") evalCount = chunk.eval_count;
    if (!isRecord(chunk.message)) continue;
    if (typeof chunk.message.content === "string")
      content += chunk.message.content;
    if (typeof chunk.message.thinking === "string")
      thinking += chunk.message.thinking;
    if (!Array.isArray(chunk.message.tool_calls)) continue;
    for (const call of chunk.message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) {
        malformed += 1;
        continue;
      }
      const fn = call.function;
      const index = typeof fn.index === "number" ? fn.index : tools.size;
      const current = tools.get(index) ?? {
        index,
        id: "",
        name: "",
        argumentText: "",
      };
      if (typeof call.id === "string" && call.id) current.id = call.id;
      if (typeof fn.name === "string" && fn.name) current.name = fn.name;
      if (typeof fn.arguments === "string")
        current.argumentText += fn.arguments;
      else if (fn.arguments !== undefined)
        current.argumentObject = fn.arguments;
      tools.set(index, current);
    }
  }

  const toolCalls = [...tools.values()]
    .sort((left, right) => left.index - right.index)
    .map((tool) => {
      let args = tool.argumentObject;
      if (args === undefined && tool.argumentText) {
        try {
          args = JSON.parse(tool.argumentText);
        } catch {
          malformed += 1;
          args = tool.argumentText;
        }
      }
      return {
        index: tool.index,
        id: tool.id,
        name: tool.name,
        arguments: args,
      };
    });

  return {
    content,
    thinking,
    toolCalls,
    done,
    ...(doneReason ? { doneReason } : {}),
    ...(promptEvalCount !== undefined ? { promptEvalCount } : {}),
    ...(evalCount !== undefined ? { evalCount } : {}),
    malformed,
  };
}

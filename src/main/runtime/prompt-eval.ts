let lastPromptEval: number | undefined;

export function notePromptEval(count: number): void {
  if (Number.isFinite(count) && count >= 0) lastPromptEval = count;
}

export function readPromptEval(): number | null {
  return lastPromptEval ?? null;
}

export type PersistedQueueItem = {
  id: string;
  text: string;
};

export type ComposerSendDecision = {
  persisted: PersistedQueueItem[];
  startRun: boolean;
  startedText?: string;
};

let queueSerial = 0;

export function resetComposerSendIds(): void {
  queueSerial = 0;
}

export function acceptComposerSend(input: {
  busy: boolean;
  text: string;
  persisted: readonly PersistedQueueItem[];
}): ComposerSendDecision {
  if (!input.busy) {
    return {
      persisted: [...input.persisted],
      startRun: true,
      startedText: input.text,
    };
  }
  queueSerial += 1;
  return {
    persisted: [
      ...input.persisted,
      { id: `queued-${queueSerial}`, text: input.text },
    ],
    startRun: false,
  };
}

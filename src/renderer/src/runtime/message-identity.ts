const canonicalIds = new Map<string, string>();
const observations = new Map<
  string,
  { userMessageId: string; assistantMessageId: string }
>();

export function holdTurnObservation(
  threadId: string,
  identity: { userMessageId: string; assistantMessageId: string },
): void {
  observations.set(threadId, identity);
}
export function takeTurnObservation(
  threadId: string,
  userMessageId?: string,
): string | undefined {
  const identity = observations.get(threadId);
  observations.delete(threadId);
  return identity?.userMessageId === userMessageId
    ? identity?.assistantMessageId
    : undefined;
}

/** Renderer message IDs can differ when it attaches to an already promoted main turn. */
export function rememberMessageIdentity(
  localId: string,
  canonicalId: string,
): void {
  if (localId !== canonicalId) canonicalIds.set(localId, canonicalId);
}
export function canonicalMessageId(id: string): string {
  return canonicalIds.get(id) ?? id;
}

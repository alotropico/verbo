let leaseId: string | null = null;

export function holdQueueLease(id: string): void {
  leaseId = id;
}

export function takeQueueLease(): string | undefined {
  const id = leaseId ?? undefined;
  leaseId = null;
  return id;
}

import { randomUUID } from "node:crypto";
import { trashItem } from "./recycle-bin";

export type MutationPorts = {
  now: () => number;
  trashItem: (absolutePath: string) => void;
  beforeItem?: (operationId: string, index: number) => void;
};

const defaults: MutationPorts = {
  now: () => Date.now(),
  trashItem,
};

let ports: MutationPorts = { ...defaults };
let sessionId: string = randomUUID();

export function mutationPorts(): MutationPorts {
  return ports;
}

export function setMutationPorts(next: Partial<MutationPorts>): void {
  ports = { ...defaults, ...ports, ...next };
}

export function resetMutationPorts(): void {
  ports = { ...defaults };
}

export function operationSession(): string {
  return sessionId;
}

export function setOperationSession(next: string): void {
  sessionId = next;
}

import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import { type CommandReceipt } from "../../shared/command-receipts";

export function readCommandReceipt(
  _database: DatabaseSync,
  id: string,
  threadId: string,
  offset = 0,
): CommandReceipt | null {
  return aloData("receipts.read", { receiptId: id, offset }, threadId);
}

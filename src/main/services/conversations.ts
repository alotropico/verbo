import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'
import type { RemoteThreadMetadata } from '../../shared/storage-ipc'
import { chatPlaceholderTitle } from '../../shared/thread-title'

export type StoredMessageRow = {
  id: string
  thread_id: string
  parent_id: string | null
  role: string
  content_json: string
  status: string
  created_at: number
}

function now(): number {
  return Date.now()
}

export function listThreads(): RemoteThreadMetadata[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT id, title, status FROM threads WHERE status != 'deleted' ORDER BY updated_at DESC`
    )
    .all() as { id: string; title: string; status: string }[]
  return rows.map((row) => ({
    status: row.status === 'archived' ? 'archived' : 'regular',
    remoteId: row.id,
    externalId: row.id,
    title: row.title
  }))
}

export function initializeThread(localId: string): { remoteId: string; externalId: string } {
  const db = getDatabase()
  const id = localId || randomUUID()
  const title = chatPlaceholderTitle(id)
  const ts = now()
  db.prepare(
    `INSERT INTO threads (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'regular', ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
  ).run(id, title, ts, ts)
  return { remoteId: id, externalId: id }
}

export function renameThread(remoteId: string, title: string): void {
  getDatabase()
    .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, now(), remoteId)
}

export function archiveThread(remoteId: string): void {
  getDatabase()
    .prepare(`UPDATE threads SET status = 'archived', updated_at = ? WHERE id = ?`)
    .run(now(), remoteId)
}

export function unarchiveThread(remoteId: string): void {
  getDatabase()
    .prepare(`UPDATE threads SET status = 'regular', updated_at = ? WHERE id = ?`)
    .run(now(), remoteId)
}

export function deleteThread(remoteId: string): void {
  const db = getDatabase()
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(remoteId)
    db.prepare(`DELETE FROM threads WHERE id = ?`).run(remoteId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function fetchThread(remoteId: string): RemoteThreadMetadata {
  const row = getDatabase()
    .prepare(`SELECT id, title, status FROM threads WHERE id = ?`)
    .get(remoteId) as { id: string; title: string; status: string } | undefined
  if (!row) {
    throw new Error('Thread not found')
  }
  return {
    status: row.status === 'archived' ? 'archived' : 'regular',
    remoteId: row.id,
    externalId: row.id,
    title: row.title
  }
}

export function loadMessageRows(threadId: string): StoredMessageRow[] {
  return getDatabase()
    .prepare(
      `SELECT id, thread_id, parent_id, role, content_json, status, created_at
       FROM messages WHERE thread_id = ? ORDER BY created_at ASC`
    )
    .all(threadId) as StoredMessageRow[]
}

export function appendMessage(
  threadId: string,
  parentId: string | undefined,
  message: unknown,
  status = 'complete'
): string {
  const db = getDatabase()
  const id = randomUUID()
  const ts = now()
  const role =
    typeof message === 'object' &&
    message !== null &&
    'role' in message &&
    typeof (message as { role: unknown }).role === 'string'
      ? (message as { role: string }).role
      : 'assistant'
  db.prepare(
    `INSERT INTO messages (id, thread_id, parent_id, role, content_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, threadId, parentId ?? null, role, JSON.stringify(message), status, ts)
  db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(ts, threadId)
  return id
}

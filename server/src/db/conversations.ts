import type { ChatMessage, Conversation } from "@brandon/shared";
import { nanoid } from "nanoid";
import { db } from "./client.js";

interface ConvRow {
  id: string; user_id: string; profile_id: string | null;
  title: string; created_at: number; updated_at: number;
}
interface MsgRow {
  id: string; conversation_id: string; role: "user" | "assistant";
  content: string; created_at: number;
}
function asRow<T>(v: unknown): T | undefined { return v as T | undefined; }
function asRows<T>(v: unknown): T[] { return v as T[]; }

function toConv(r: ConvRow): Conversation {
  return { id: r.id, profileId: r.profile_id, title: r.title, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function toMsg(r: MsgRow): ChatMessage {
  return { id: r.id, role: r.role, content: r.content, createdAt: Number(r.created_at) };
}

// All scoped to the owning user — a conversation that isn't yours returns null.
export function listConversations(userId: string): Conversation[] {
  return asRows<ConvRow>(
    db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC").all(userId),
  ).map(toConv);
}

export function getConversation(id: string, userId: string): Conversation | null {
  const r = asRow<ConvRow>(db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId));
  return r ? toConv(r) : null;
}

export function createConversation(userId: string, profileId: string | null, title = "New chat"): Conversation {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    "INSERT INTO conversations (id, user_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, profileId, title, now, now);
  return toConv(asRow<ConvRow>(db.prepare("SELECT * FROM conversations WHERE id = ?").get(id))!);
}

export function renameConversation(id: string, userId: string, title: string): void {
  db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(title, Date.now(), id, userId);
}

export function touchConversation(id: string, userId: string): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), id, userId);
}

export function deleteConversation(id: string, userId: string): boolean {
  // messages cascade via FK.
  const r = db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(r.changes) > 0;
}

export function listMessages(conversationId: string): ChatMessage[] {
  return asRows<MsgRow>(
    db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId),
  ).map(toMsg);
}

export function addMessage(conversationId: string, role: "user" | "assistant", content: string): ChatMessage {
  const id = nanoid(12);
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, conversationId, role, content, Date.now());
  return toMsg(asRow<MsgRow>(db.prepare("SELECT * FROM messages WHERE id = ?").get(id))!);
}

import { nanoid } from "nanoid";
import { db } from "./client.js";

export interface UsageRow {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
}

function asRows<T>(v: unknown): T[] { return v as T[]; }

/** Record one chat call's token usage. Best-effort — never throws into the
 *  request path (a logging failure shouldn't break a streamed answer). */
export function logUsage(input: {
  userId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  try {
    db.prepare(
      `INSERT INTO usage_log (id, user_id, provider, model, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nanoid(12), input.userId, input.provider, input.model,
          input.inputTokens | 0, input.outputTokens | 0, Date.now());
  } catch { /* don't let usage logging break chat */ }
}

export interface UsageTotals {
  userId: string;
  email: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: number | null;
}

/** Per-user usage totals across all users (admin view). Joins users so the
 *  admin sees emails, and includes users with zero usage. */
export function getAllUsageTotals(): UsageTotals[] {
  const rows = asRows<{
    user_id: string; email: string; requests: number;
    in_tok: number; out_tok: number; last_at: number | null;
  }>(
    db.prepare(
      `SELECT u.id AS user_id, u.email AS email,
              COUNT(l.id) AS requests,
              COALESCE(SUM(l.input_tokens), 0) AS in_tok,
              COALESCE(SUM(l.output_tokens), 0) AS out_tok,
              MAX(l.created_at) AS last_at
         FROM users u
         LEFT JOIN usage_log l ON l.user_id = u.id
        GROUP BY u.id
        ORDER BY requests DESC, u.email ASC`,
    ).all(),
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    requests: Number(r.requests),
    inputTokens: Number(r.in_tok),
    outputTokens: Number(r.out_tok),
    lastUsedAt: r.last_at === null ? null : Number(r.last_at),
  }));
}

/** A single user's own totals (the "see your own usage" path). */
export function getUserUsageTotals(userId: string): { requests: number; inputTokens: number; outputTokens: number } {
  const r = db.prepare(
    `SELECT COUNT(id) AS requests,
            COALESCE(SUM(input_tokens), 0) AS in_tok,
            COALESCE(SUM(output_tokens), 0) AS out_tok
       FROM usage_log WHERE user_id = ?`,
  ).get(userId) as { requests: number; in_tok: number; out_tok: number };
  return { requests: Number(r.requests), inputTokens: Number(r.in_tok), outputTokens: Number(r.out_tok) };
}

export interface UsageCall {
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
}

/** Recent calls for one user (admin drill-in). */
export function getRecentCalls(userId: string, limit = 50): UsageCall[] {
  return asRows<UsageRow>(
    db.prepare("SELECT * FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit),
  ).map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    createdAt: Number(r.created_at),
  }));
}

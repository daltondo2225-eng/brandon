import type { Session } from "@brandon/shared";
import { nanoid } from "nanoid";
import { db } from "./client.js";

interface Row {
  id: string;
  profile_id: string | null;
  title: string;
  started_at: number;
  ended_at: number | null;
  transcript: string | null;
  recap: string | null;
  target_company: string | null;
  job_description: string | null;
  company_id: string | null;
  next_steps_json: string | null;
  prior_turns_json: string | null;
}

function asRow<T>(value: unknown): T | undefined { return value as T | undefined; }
function asRows<T>(value: unknown): T[] { return value as T[]; }

function toSession(r: Row): Session {
  return {
    id: r.id,
    profileId: r.profile_id,
    title: r.title || "Untitled meeting",
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    transcript: r.transcript ?? null,
    recap: r.recap ?? null,
    targetCompany: r.target_company ?? null,
    jobDescription: r.job_description ?? null,
    priorTurnsJson: r.prior_turns_json ?? null,
  };
}

export function listSessions(userId: string, profileId?: string, limit = 50): Session[] {
  const rows = profileId
    ? asRows<Row>(
        db.prepare("SELECT * FROM sessions WHERE user_id = ? AND profile_id = ? ORDER BY started_at DESC LIMIT ?").all(userId, profileId, limit),
      )
    : asRows<Row>(
        db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?").all(userId, limit),
      );
  return rows.map(toSession);
}

export function getSession(id: string, userId: string): Session | null {
  const r = asRow<Row>(db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ?").get(id, userId));
  return r ? toSession(r) : null;
}

export function createSession(
  userId: string,
  profileId: string | null,
  title: string,
  targetCompany: string | null = null,
  jobDescription: string | null = null,
  companyId: string | null = null,
): Session {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, user_id, profile_id, title, started_at, ended_at, target_company, job_description, company_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(id, userId, profileId, title || "Untitled meeting", now, targetCompany, jobDescription, companyId);
  return toSession(asRow<Row>(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id))!);
}

/** Link a session to a company. Pass null to detach. Scoped to the owner. */
export function setSessionCompany(sessionId: string, companyId: string | null, userId: string): void {
  db.prepare("UPDATE sessions SET company_id = ? WHERE id = ? AND user_id = ?").run(companyId, sessionId, userId);
}

/** Find the most recent unended session for a profile (used by /chat to look up context). */
export function findActiveSessionForProfile(profileId: string, userId: string): Session | null {
  const r = asRow<Row>(
    db.prepare(
      "SELECT * FROM sessions WHERE profile_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    ).get(profileId, userId),
  );
  return r ? toSession(r) : null;
}

export interface UpdateSessionInput {
  title?: string;
  endedAt?: number | null;
  transcript?: string | null;
  recap?: string | null;
  /** JSON-encoded array of NextStepItem. Pass null to clear. */
  nextStepsJson?: string | null;
  /** JSON-encoded DisplayTurn[] (overlay's Q&A history). Pass null to clear. */
  priorTurnsJson?: string | null;
}

export function updateSession(id: string, input: UpdateSessionInput, userId: string): Session | null {
  const existing = asRow<Row>(db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ?").get(id, userId));
  if (!existing) return null;
  db.prepare(
    `UPDATE sessions
     SET title = COALESCE(?, title),
         ended_at = ?,
         transcript = ?,
         recap = ?,
         next_steps_json = ?,
         prior_turns_json = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    input.title ?? null,
    input.endedAt === undefined ? existing.ended_at : input.endedAt,
    input.transcript === undefined ? existing.transcript : input.transcript,
    input.recap === undefined ? existing.recap : input.recap,
    input.nextStepsJson === undefined ? existing.next_steps_json : input.nextStepsJson,
    input.priorTurnsJson === undefined ? existing.prior_turns_json : input.priorTurnsJson,
    id,
    userId,
  );
  return toSession(asRow<Row>(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id))!);
}

export function deleteSession(id: string, userId: string): boolean {
  const result = db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(result.changes) > 0;
}

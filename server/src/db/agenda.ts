import type { AgendaItem, NextStepItem } from "@brandon/shared";
import { db } from "./client.js";

interface Row {
  id: string;
  title: string;
  started_at: number;
  profile_id: string | null;
  company_id: string | null;
  next_steps_json: string | null;
  company_name: string | null;
}

function asRows<T>(v: unknown): T[] { return v as T[]; }

/**
 * Flatten all sessions' structured next-steps into a single agenda stream,
 * optionally scoped to one profile. Items without `dueDate` are excluded —
 * the calendar only renders dated things.
 */
export function listAgenda(userId: string, profileId?: string): AgendaItem[] {
  const rows = profileId
    ? asRows<Row>(
        db.prepare(
          `SELECT s.id, s.title, s.started_at, s.profile_id, s.company_id, s.next_steps_json,
                  c.name AS company_name
             FROM sessions s
             LEFT JOIN companies c ON c.id = s.company_id
            WHERE s.next_steps_json IS NOT NULL AND s.user_id = ? AND s.profile_id = ?
            ORDER BY s.started_at DESC`,
        ).all(userId, profileId),
      )
    : asRows<Row>(
        db.prepare(
          `SELECT s.id, s.title, s.started_at, s.profile_id, s.company_id, s.next_steps_json,
                  c.name AS company_name
             FROM sessions s
             LEFT JOIN companies c ON c.id = s.company_id
            WHERE s.next_steps_json IS NOT NULL AND s.user_id = ?
            ORDER BY s.started_at DESC`,
        ).all(userId),
      );

  const items: AgendaItem[] = [];
  for (const r of rows) {
    let parsed: NextStepItem[] = [];
    try {
      const raw = JSON.parse(r.next_steps_json ?? "[]") as unknown;
      if (Array.isArray(raw)) parsed = raw as NextStepItem[];
    } catch { continue; }
    parsed.forEach((it, idx) => {
      if (!it || typeof it !== "object") return;
      if (typeof it.action !== "string" || !it.action.trim()) return;
      if (!it.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(it.dueDate)) return; // calendar = dated only
      items.push({
        id: `${r.id}-${idx}`,
        sessionId: r.id,
        sessionTitle: r.title,
        companyId: r.company_id,
        companyName: r.company_name,
        meetingAt: Number(r.started_at),
        action: it.action.trim(),
        dueDate: it.dueDate,
        owner: it.owner ?? null,
      });
    });
  }
  // Sort by dueDate ascending — calendar reads oldest-first by date string.
  items.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  return items;
}

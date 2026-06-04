import type { Company, CompanyStatus, PipelineEntry } from "@brandon/shared";
import { nanoid } from "nanoid";
import { db } from "./client.js";

interface Row {
  id: string;
  name: string;
  name_key: string;
  status: string;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function asRow<T>(v: unknown): T | undefined { return v as T | undefined; }
function asRows<T>(v: unknown): T[] { return v as T[]; }

function toCompany(r: Row): Company {
  return {
    id: r.id,
    name: r.name,
    status: (r.status as CompanyStatus) ?? "active",
    notes: r.notes ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Lowercased + collapsed-whitespace key for case-insensitive name dedupe. */
export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function listCompanies(): Company[] {
  return asRows<Row>(
    db.prepare("SELECT * FROM companies ORDER BY updated_at DESC").all(),
  ).map(toCompany);
}

export function getCompany(id: string): Company | null {
  const r = asRow<Row>(db.prepare("SELECT * FROM companies WHERE id = ?").get(id));
  return r ? toCompany(r) : null;
}

export function findCompanyByName(name: string): Company | null {
  const key = normalizeCompanyName(name);
  if (!key) return null;
  const r = asRow<Row>(db.prepare("SELECT * FROM companies WHERE name_key = ?").get(key));
  return r ? toCompany(r) : null;
}

export function createCompany(name: string, status: CompanyStatus = "active"): Company {
  const clean = name.trim();
  if (!clean) throw new Error("Company name cannot be empty");
  const key = normalizeCompanyName(clean);
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO companies (id, name, name_key, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, clean, key, status, now, now);
  return toCompany(asRow<Row>(db.prepare("SELECT * FROM companies WHERE id = ?").get(id))!);
}

/** Find by name, creating if missing. The canonical case is "first one wins". */
export function upsertCompanyByName(name: string): Company {
  return findCompanyByName(name) ?? createCompany(name);
}

export interface UpdateCompanyInput {
  name?: string;
  status?: CompanyStatus;
  notes?: string | null;
}

export function updateCompany(id: string, input: UpdateCompanyInput): Company | null {
  const existing = asRow<Row>(db.prepare("SELECT * FROM companies WHERE id = ?").get(id));
  if (!existing) return null;
  const newName = input.name?.trim();
  const newKey = newName ? normalizeCompanyName(newName) : null;
  db.prepare(
    `UPDATE companies
        SET name = COALESCE(?, name),
            name_key = COALESCE(?, name_key),
            status = COALESCE(?, status),
            notes = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    newName ?? null,
    newKey,
    input.status ?? null,
    input.notes === undefined ? existing.notes : input.notes,
    Date.now(),
    id,
  );
  return toCompany(asRow<Row>(db.prepare("SELECT * FROM companies WHERE id = ?").get(id))!);
}

export function deleteCompany(id: string): boolean {
  // Sessions with this company_id will be set NULL by the FK constraint.
  const r = db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  return Number(r.changes) > 0;
}

interface SessionAggRow {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  recap: string | null;
  company_id: string;
}

/**
 * Build the pipeline view: companies with their session list, latest stage,
 * last contact, and next-steps bullets. When `profileId` is provided, only
 * sessions for that profile count — companies with no sessions under this
 * profile are omitted entirely.
 */
export function listPipeline(profileId?: string): PipelineEntry[] {
  const companies = listCompanies();
  if (companies.length === 0) return [];
  // Pull all relevant sessions in one query so we don't N+1.
  const rows = profileId
    ? asRows<SessionAggRow>(
        db.prepare(
          `SELECT id, title, started_at, ended_at, recap, company_id
             FROM sessions
            WHERE company_id IS NOT NULL AND profile_id = ?
            ORDER BY started_at DESC`,
        ).all(profileId),
      )
    : asRows<SessionAggRow>(
        db.prepare(
          `SELECT id, title, started_at, ended_at, recap, company_id
             FROM sessions
            WHERE company_id IS NOT NULL
            ORDER BY started_at DESC`,
        ).all(),
      );
  const byCompany = new Map<string, SessionAggRow[]>();
  for (const r of rows) {
    const list = byCompany.get(r.company_id) ?? [];
    list.push(r);
    byCompany.set(r.company_id, list);
  }
  return companies
    .filter((c) => !profileId || byCompany.has(c.id))
    .map((c) => {
      const sessions = byCompany.get(c.id) ?? [];
      const latest = sessions[0] ?? null;
      return {
        ...c,
        sessionCount: sessions.length,
        lastContactAt: latest ? Number(latest.started_at) : null,
        latestStage: latest ? parseStageFromTitle(latest.title) : null,
        latestSessionTitle: latest ? latest.title : null,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          startedAt: Number(s.started_at),
          endedAt: s.ended_at === null ? null : Number(s.ended_at),
        })),
        nextSteps: latest?.recap ? parseNextStepsFromRecap(latest.recap) : [],
      };
    });
}

/**
 * Extract the interview stage from a Claude-generated title like
 * "Recruiter screen with Mercury" → "Recruiter screen".
 * Splits on the first occurrence of a connector (with / — / · / -) and
 * returns the leading part trimmed.
 */
export function parseStageFromTitle(title: string): string | null {
  if (!title) return null;
  const m = title.match(/^(.+?)\s+(?:with|—|·|-)\s+/i);
  return m ? m[1].trim() : null;
}

/**
 * Pull bullet items out of the `## Next steps` section of a recap markdown.
 * Robust to extra blank lines, alternative bullet chars, and missing section.
 */
export function parseNextStepsFromRecap(recap: string): string[] {
  if (!recap) return [];
  // Capture from "## Next steps" up to the next ## heading (or end-of-string).
  const m = recap.match(/##\s*Next\s*steps\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  if (!m) return [];
  return m[1]
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0);
}

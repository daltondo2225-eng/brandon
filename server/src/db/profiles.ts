import type { ModelId, Profile, ProfileWithFiles, ReferenceFile } from "@brandon/shared";
import { DEFAULT_REALTIME_PROMPT } from "@brandon/shared";
import { nanoid } from "nanoid";
import { db, tx } from "./client.js";

function asRow<T>(value: unknown): T | undefined {
  return value as T | undefined;
}
function asRows<T>(value: unknown): T[] {
  return value as T[];
}

interface ProfileRow {
  id: string;
  name: string;
  realtime_prompt: string;
  notes_template: string | null;
  model: string;
  is_active: number;
  full_name: string | null;
  job_title: string | null;
  company: string | null;
  location: string | null;
  voice_sample: string | null;
  interview_brief: string | null;
  repo_root: string | null;
  created_at: number;
  updated_at: number;
}

interface FileRow {
  id: string;
  profile_id: string;
  filename: string;
  mime: string;
  size: number;
  storage_path: string;
  extracted_text: string;
  char_count: number;
  created_at: number;
}

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    realtimePrompt: row.realtime_prompt,
    notesTemplate: row.notes_template,
    model: row.model as ModelId,
    isActive: row.is_active === 1,
    fullName: row.full_name ?? null,
    jobTitle: row.job_title ?? null,
    company: row.company ?? null,
    location: row.location ?? null,
    voiceSample: row.voice_sample ?? null,
    interviewBrief: row.interview_brief ?? null,
    repoRoot: row.repo_root ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toFile(row: FileRow): ReferenceFile {
  return {
    id: row.id,
    profileId: row.profile_id,
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size),
    charCount: Number(row.char_count),
    createdAt: Number(row.created_at),
  };
}

// Every accessor is scoped to the owning user. A by-id read that isn't yours
// returns null (→ the route 404s), so existence never leaks across tenants.
const PROFILE_BY_ID = "SELECT * FROM profiles WHERE id = ? AND user_id = ?";

export function listProfiles(userId: string): Profile[] {
  return asRows<ProfileRow>(
    db.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC").all(userId),
  ).map(toProfile);
}

export function getProfile(id: string, userId: string): ProfileWithFiles | null {
  const row = asRow<ProfileRow>(db.prepare(PROFILE_BY_ID).get(id, userId));
  if (!row) return null;
  const files = asRows<FileRow>(
    db.prepare("SELECT * FROM reference_files WHERE profile_id = ? ORDER BY created_at ASC").all(id),
  ).map(toFile);
  return { ...toProfile(row), files };
}

export interface CreateProfileInput {
  name: string;
  realtimePrompt?: string;
  notesTemplate?: string | null;
  model?: ModelId;
}

export function createProfile(input: CreateProfileInput, userId: string): Profile {
  const now = Date.now();
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO profiles (id, user_id, name, realtime_prompt, notes_template, model, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.realtimePrompt ?? DEFAULT_REALTIME_PROMPT,
    input.notesTemplate ?? null,
    input.model ?? "gpt-4o",
    now,
    now,
  );
  return toProfile(asRow<ProfileRow>(db.prepare(PROFILE_BY_ID).get(id, userId))!);
}

export interface UpdateProfileInput {
  name?: string;
  realtimePrompt?: string;
  notesTemplate?: string | null;
  model?: ModelId;
  fullName?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  location?: string | null;
  voiceSample?: string | null;
  interviewBrief?: string | null;
  repoRoot?: string | null;
}

export function updateProfile(id: string, input: UpdateProfileInput, userId: string): Profile | null {
  const existing = asRow<ProfileRow>(db.prepare(PROFILE_BY_ID).get(id, userId));
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE profiles
     SET name = COALESCE(?, name),
         realtime_prompt = COALESCE(?, realtime_prompt),
         notes_template = ?,
         model = COALESCE(?, model),
         full_name = ?,
         job_title = ?,
         company = ?,
         location = ?,
         voice_sample = ?,
         interview_brief = ?,
         repo_root = ?,
         updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    input.name ?? null,
    input.realtimePrompt ?? null,
    input.notesTemplate === undefined ? existing.notes_template : input.notesTemplate,
    input.model ?? null,
    input.fullName === undefined ? existing.full_name : input.fullName,
    input.jobTitle === undefined ? existing.job_title : input.jobTitle,
    input.company === undefined ? existing.company : input.company,
    input.location === undefined ? existing.location : input.location,
    input.voiceSample === undefined ? existing.voice_sample : input.voiceSample,
    input.interviewBrief === undefined ? existing.interview_brief : input.interviewBrief,
    input.repoRoot === undefined ? existing.repo_root : input.repoRoot,
    now,
    id,
    userId,
  );
  return toProfile(asRow<ProfileRow>(db.prepare(PROFILE_BY_ID).get(id, userId))!);
}

export function deleteProfile(id: string, userId: string): boolean {
  const result = db.prepare("DELETE FROM profiles WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(result.changes) > 0;
}

export function activateProfile(id: string, userId: string): Profile | null {
  const changed = tx(() => {
    db.prepare("UPDATE profiles SET is_active = 0 WHERE is_active = 1 AND user_id = ?").run(userId);
    const result = db
      .prepare("UPDATE profiles SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(Date.now(), id, userId);
    return Number(result.changes) > 0;
  });
  if (!changed) return null;
  return toProfile(asRow<ProfileRow>(db.prepare(PROFILE_BY_ID).get(id, userId))!);
}

export function getActiveProfile(userId: string): ProfileWithFiles | null {
  const row = asRow<ProfileRow>(
    db.prepare("SELECT * FROM profiles WHERE is_active = 1 AND user_id = ?").get(userId),
  );
  if (!row) return null;
  return getProfile(row.id, userId);
}

export interface InsertFileInput {
  profileId: string;
  filename: string;
  mime: string;
  size: number;
  storagePath: string;
  extractedText: string;
}

export function insertReferenceFile(input: InsertFileInput): ReferenceFile {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO reference_files
     (id, profile_id, filename, mime, size, storage_path, extracted_text, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.profileId,
    input.filename,
    input.mime,
    input.size,
    input.storagePath,
    input.extractedText,
    input.extractedText.length,
    now,
  );
  db.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").run(now, input.profileId);
  return toFile(asRow<FileRow>(db.prepare("SELECT * FROM reference_files WHERE id = ?").get(id))!);
}

// Scoped through the owning profile (reference_files has no user_id of its own).
// A file that isn't yours returns null, so a user can't read/delete another
// user's file by guessing its id (IDOR protection).
export function getReferenceFile(id: string, userId: string): { file: ReferenceFile; storagePath: string; extractedText: string } | null {
  const row = asRow<FileRow>(
    db.prepare(
      `SELECT rf.* FROM reference_files rf
       JOIN profiles p ON p.id = rf.profile_id
       WHERE rf.id = ? AND p.user_id = ?`,
    ).get(id, userId),
  );
  if (!row) return null;
  return { file: toFile(row), storagePath: row.storage_path, extractedText: row.extracted_text };
}

export function deleteReferenceFile(id: string, userId: string): boolean {
  const row = asRow<{ profile_id: string }>(
    db.prepare(
      `SELECT rf.profile_id FROM reference_files rf
       JOIN profiles p ON p.id = rf.profile_id
       WHERE rf.id = ? AND p.user_id = ?`,
    ).get(id, userId),
  );
  if (!row) return false;
  const result = db.prepare("DELETE FROM reference_files WHERE id = ?").run(id);
  if (Number(result.changes) > 0) {
    db.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").run(Date.now(), row.profile_id);
    return true;
  }
  return false;
}

export function listProfileFilesWithText(profileId: string): Array<ReferenceFile & { extractedText: string }> {
  const rows = asRows<FileRow>(
    db.prepare("SELECT * FROM reference_files WHERE profile_id = ? ORDER BY created_at ASC").all(profileId),
  );
  return rows.map((r) => ({ ...toFile(r), extractedText: r.extracted_text }));
}

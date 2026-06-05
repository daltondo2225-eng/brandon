import { nanoid } from "nanoid";
import { db } from "./client.js";

export type UserRole = "user" | "superadmin";
export type UserStatus = "pending" | "active" | "disabled";

export interface UserRow {
  id: string;
  email: string;
  email_key: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  default_interview_brief: string | null;
  default_voice_sample: string | null;
  created_at: number;
  updated_at: number;
}

/** Public-safe shape — NEVER includes password_hash. */
export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
}

export function toPublicUser(r: UserRow): PublicUser {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status,
    createdAt: Number(r.created_at),
  };
}

function asRow<T>(v: unknown): T | undefined { return v as T | undefined; }
function asRows<T>(v: unknown): T[] { return v as T[]; }

/** lower(trim(email)) — the case-insensitive uniqueness key. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findUserByEmail(email: string): UserRow | null {
  const key = normalizeEmail(email);
  if (!key) return null;
  return asRow<UserRow>(db.prepare("SELECT * FROM users WHERE email_key = ?").get(key)) ?? null;
}

export function getUserById(id: string): UserRow | null {
  return asRow<UserRow>(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) ?? null;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role?: UserRole;
  status?: UserStatus;
}

export function createUser(input: CreateUserInput): UserRow {
  const id = nanoid(12);
  const now = Date.now();
  const clean = input.email.trim();
  const key = normalizeEmail(clean);
  db.prepare(
    `INSERT INTO users (id, email, email_key, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    clean,
    key,
    input.passwordHash,
    input.role ?? "user",
    input.status ?? "pending",
    now,
    now,
  );
  return getUserById(id)!;
}

export function listUsers(): PublicUser[] {
  return asRows<UserRow>(
    db.prepare("SELECT * FROM users ORDER BY created_at ASC").all(),
  ).map(toPublicUser);
}

export function setUserStatus(id: string, status: UserStatus): PublicUser | null {
  const r = db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
  if (Number(r.changes) === 0) return null;
  return toPublicUser(getUserById(id)!);
}

export function setUserRole(id: string, role: UserRole): void {
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, Date.now(), id);
}

export interface UserDefaults {
  defaultInterviewBrief: string;
  defaultVoiceSample: string;
}

export function getUserDefaults(userId: string): UserDefaults {
  const r = asRow<Pick<UserRow, "default_interview_brief" | "default_voice_sample">>(
    db.prepare("SELECT default_interview_brief, default_voice_sample FROM users WHERE id = ?").get(userId),
  );
  return {
    defaultInterviewBrief: r?.default_interview_brief ?? "",
    defaultVoiceSample: r?.default_voice_sample ?? "",
  };
}

export function setUserDefaults(userId: string, input: Partial<UserDefaults>): UserDefaults {
  if (input.defaultInterviewBrief !== undefined) {
    db.prepare("UPDATE users SET default_interview_brief = ?, updated_at = ? WHERE id = ?")
      .run(input.defaultInterviewBrief.trim() || null, Date.now(), userId);
  }
  if (input.defaultVoiceSample !== undefined) {
    db.prepare("UPDATE users SET default_voice_sample = ?, updated_at = ? WHERE id = ?")
      .run(input.defaultVoiceSample.trim() || null, Date.now(), userId);
  }
  return getUserDefaults(userId);
}

import type { AgendaItem, ChatChunk, ChatImage, ChatMessage, ChatTurn, Company, CompanyStatus, Conversation, PipelineEntry, Profile, ProfileWithFiles, ReferenceFile, Session } from "@brandon/shared";
import { bridge, getConfig } from "./bridge";

// Called when any request returns 401 (token missing/invalid/expired). The
// AuthGate registers a handler that clears state and routes back to login.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = (await bridge.getToken()) ?? "";
  return { Authorization: `Bearer ${token}`, ...(extra ?? {}) };
}

async function jsonHeaders(): Promise<Record<string, string>> {
  return authHeaders({ "Content-Type": "application/json" });
}

async function base(): Promise<string> {
  const { serverBase } = await getConfig();
  return serverBase;
}

/** Thrown for a 403 from a non-active account so the UI can show the pending screen. */
export class PendingApprovalError extends Error {
  constructor() { super("account_pending_approval"); this.name = "PendingApprovalError"; }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 && text.includes("account_pending_approval")) {
      throw new PendingApprovalError();
    }
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch(`${await base()}/profiles`, { headers: await authHeaders() });
  const data = await handle<{ profiles: Profile[] }>(res);
  return data.profiles;
}

export async function getProfile(id: string): Promise<ProfileWithFiles> {
  const res = await fetch(`${await base()}/profiles/${id}`, { headers: await authHeaders() });
  return handle<ProfileWithFiles>(res);
}

export async function createProfile(input: { name: string; realtimePrompt?: string; model?: string }): Promise<Profile> {
  const res = await fetch(`${await base()}/profiles`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return handle<Profile>(res);
}

export async function updateProfile(id: string, input: Partial<Pick<Profile, "name" | "realtimePrompt" | "notesTemplate" | "model" | "fullName" | "jobTitle" | "company" | "location" | "voiceSample" | "interviewBrief">>): Promise<Profile> {
  const res = await fetch(`${await base()}/profiles/${id}`, {
    method: "PATCH",
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return handle<Profile>(res);
}

export async function deleteProfile(id: string): Promise<void> {
  const res = await fetch(`${await base()}/profiles/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function activateProfile(id: string): Promise<Profile> {
  const res = await fetch(`${await base()}/profiles/${id}/activate`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: "{}",
  });
  return handle<Profile>(res);
}

export async function listSessions(profileId?: string): Promise<Session[]> {
  const url = new URL(`${await base()}/sessions`);
  if (profileId) url.searchParams.set("profileId", profileId);
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  const data = await handle<{ sessions: Session[] }>(res);
  return data.sessions;
}

export async function createSession(
  profileId: string | null,
  options: { title?: string; targetCompany?: string | null; jobDescription?: string | null } = {},
): Promise<Session> {
  const res = await fetch(`${await base()}/sessions`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ profileId, ...options }),
  });
  return handle<Session>(res);
}

export async function updateSession(id: string, input: { title?: string; endedAt?: number | null; transcript?: string | null; recap?: string | null; priorTurnsJson?: string | null }): Promise<Session> {
  const res = await fetch(`${await base()}/sessions/${id}`, {
    method: "PATCH",
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return handle<Session>(res);
}

export async function getSession(id: string): Promise<Session> {
  const res = await fetch(`${await base()}/sessions/${id}`, { headers: await authHeaders() });
  return handle<Session>(res);
}

export async function listPipeline(profileId?: string): Promise<PipelineEntry[]> {
  const url = new URL(`${await base()}/companies`);
  if (profileId) url.searchParams.set("profileId", profileId);
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  const data = await handle<{ companies: PipelineEntry[] }>(res);
  return data.companies;
}

export async function updateCompany(id: string, input: { name?: string; status?: CompanyStatus; notes?: string | null }): Promise<Company> {
  const res = await fetch(`${await base()}/companies/${id}`, {
    method: "PATCH",
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return handle<Company>(res);
}

export async function listAgenda(profileId?: string): Promise<AgendaItem[]> {
  const url = new URL(`${await base()}/agenda`);
  if (profileId) url.searchParams.set("profileId", profileId);
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  const data = await handle<{ items: AgendaItem[] }>(res);
  return data.items;
}

export async function deleteCompany(id: string): Promise<void> {
  const res = await fetch(`${await base()}/companies/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

// ── Auth ──────────────────────────────────────────────────────────────────
export type UserStatus = "pending" | "active" | "disabled";
export type UserRole = "user" | "superadmin";
export interface AuthUser { id: string; email: string; role: UserRole; status: UserStatus; createdAt: number; }

/** POST without auth header (signup/login are public). On success stores the JWT. */
async function authPost(path: string, body: unknown): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${await base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch { /* keep text */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token: string; user: AuthUser };
  bridge.setToken(data.token);
  return data;
}

export const signup = (email: string, password: string) => authPost("/auth/signup", { email, password });
export const login = (email: string, password: string) => authPost("/auth/login", { email, password });

export async function me(): Promise<AuthUser> {
  const res = await fetch(`${await base()}/auth/me`, { headers: await authHeaders() });
  const data = await handle<{ user: AuthUser }>(res);
  return data.user;
}

export function logout(): void { bridge.clearToken(); }

// ── Server key status (boolean only — keys are server-owned) ────────────────
export interface KeyStatus { anthropicKeySet: boolean; openaiKeySet: boolean; geminiKeySet: boolean; }
export async function getServerKeyStatus(): Promise<KeyStatus> {
  const res = await fetch(`${await base()}/settings/status`, { headers: await authHeaders() });
  return handle<KeyStatus>(res);
}

// ── Super-admin ─────────────────────────────────────────────────────────────
export async function adminListUsers(): Promise<AuthUser[]> {
  const res = await fetch(`${await base()}/admin/users`, { headers: await authHeaders() });
  const data = await handle<{ users: AuthUser[] }>(res);
  return data.users;
}
export async function adminApprove(id: string): Promise<void> {
  const res = await fetch(`${await base()}/admin/users/${id}/approve`, { method: "POST", headers: await authHeaders() });
  await handle<unknown>(res);
}
export async function adminDisable(id: string): Promise<void> {
  const res = await fetch(`${await base()}/admin/users/${id}/disable`, { method: "POST", headers: await authHeaders() });
  await handle<unknown>(res);
}

// ── Admin: shared provider keys (DB-backed, admin-editable) ─────────────────
export type ProviderName = "anthropic" | "openai" | "gemini";
export interface ProviderKeyInfo { set: boolean; preview: string | null; source: "db" | "env" | "none"; }
export type ProviderKeys = Record<ProviderName, ProviderKeyInfo>;

export async function adminGetKeys(): Promise<ProviderKeys> {
  const res = await fetch(`${await base()}/settings/keys`, { headers: await authHeaders() });
  return handle<ProviderKeys>(res);
}
export async function adminSetKey(provider: ProviderName, key: string | null): Promise<ProviderKeyInfo> {
  const res = await fetch(`${await base()}/settings/keys`, {
    method: "PUT",
    headers: await jsonHeaders(),
    body: JSON.stringify({ provider, key }),
  });
  return handle<ProviderKeyInfo>(res);
}

// ── Usage ───────────────────────────────────────────────────────────────────
// Weather is proxied through the server (the client never calls external APIs).
export interface Weather { tempF: number; description: string; localTime: string; }
export async function getWeather(location: string): Promise<Weather | null> {
  const res = await fetch(`${await base()}/weather?location=${encodeURIComponent(location)}`, { headers: await authHeaders() });
  if (res.status === 404) return null;
  return handle<Weather>(res);
}

export interface OwnUsage { requests: number; inputTokens: number; outputTokens: number; }
export async function getMyUsage(): Promise<OwnUsage> {
  const res = await fetch(`${await base()}/settings/usage`, { headers: await authHeaders() });
  return handle<OwnUsage>(res);
}

export interface UsageTotals { userId: string; email: string; requests: number; inputTokens: number; outputTokens: number; lastUsedAt: number | null; }
export async function adminGetUsage(): Promise<UsageTotals[]> {
  const res = await fetch(`${await base()}/admin/usage`, { headers: await authHeaders() });
  const data = await handle<{ usage: UsageTotals[] }>(res);
  return data.usage;
}

export interface UsageCall { id: string; provider: string; model: string; inputTokens: number; outputTokens: number; createdAt: number; }
export async function adminGetUserCalls(id: string): Promise<UsageCall[]> {
  const res = await fetch(`${await base()}/admin/usage/${id}`, { headers: await authHeaders() });
  const data = await handle<{ calls: UsageCall[] }>(res);
  return data.calls;
}

export interface GlobalDefaults {
  defaultInterviewBrief: string;
  defaultVoiceSample: string;
}

export async function getDefaults(): Promise<GlobalDefaults> {
  const res = await fetch(`${await base()}/settings/defaults`, { headers: await authHeaders() });
  return handle<GlobalDefaults>(res);
}

export async function saveDefaults(input: Partial<GlobalDefaults>): Promise<GlobalDefaults> {
  const res = await fetch(`${await base()}/settings/defaults`, {
    method: "PUT",
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return handle<GlobalDefaults>(res);
}

export async function generateRecap(id: string): Promise<Session> {
  const res = await fetch(`${await base()}/sessions/${id}/recap`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: "{}",
  });
  return handle<Session>(res);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${await base()}/sessions/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function extractIdentity(id: string): Promise<Profile> {
  const res = await fetch(`${await base()}/profiles/${id}/extract-identity`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: "{}",
  });
  return handle<Profile>(res);
}

export async function uploadFile(profileId: string, file: File): Promise<ReferenceFile> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${await base()}/profiles/${profileId}/files`, {
    method: "POST",
    headers: await authHeaders(),
    body: form,
  });
  return handle<ReferenceFile>(res);
}

export async function deleteFile(fileId: string): Promise<void> {
  const res = await fetch(`${await base()}/files/${fileId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

/** A code-tool invocation event surfaced from the server while a chat is streaming. */
export interface ToolEvent {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Short human-readable description, e.g. "read backend/TodoApi/...:19-91". */
  summary: string;
}

export interface ChatStreamHandlers {
  onText: (text: string) => void;
  onDone: (chunk: Extract<ChatChunk, { type: "done" }>) => void;
  onError: (message: string) => void;
  /** Fires when the model invokes read_file / list_dir against the profile's repoRoot. */
  onTool?: (event: ToolEvent) => void;
}

export async function streamChat(
  body: { profileId: string; transcriptWindow: string; userIntent?: string; priorTurns?: ChatTurn[]; images?: ChatImage[] },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${await base()}/chat`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    handlers.onError(`HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSSEBlock(block);
      if (!event) continue;
      if (event.event === "chunk") {
        if (event.data.type === "text") handlers.onText(event.data.text);
        if (event.data.type === "error") handlers.onError(event.data.message);
        if (event.data.type === "tool" && handlers.onTool) {
          handlers.onTool({
            name: event.data.name,
            input: event.data.input ?? {},
            ok: !!event.data.ok,
            summary: event.data.summary ?? "",
          });
        }
      } else if (event.event === "done") {
        handlers.onDone(event.data);
      }
    }
  }
}

function parseSSEBlock(block: string): { event: string; data: any } | null {
  let event = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

// Shared SSE pump for any /…/messages-style streaming endpoint.
async function pumpSSE(res: Response, handlers: ChatStreamHandlers): Promise<void> {
  if (!res.ok || !res.body) { handlers.onError(`HTTP ${res.status}: ${await res.text()}`); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSSEBlock(block);
      if (!event) continue;
      if (event.event === "chunk") {
        if (event.data.type === "text") handlers.onText(event.data.text);
        if (event.data.type === "error") handlers.onError(event.data.message);
        if (event.data.type === "tool" && handlers.onTool) {
          handlers.onTool({ name: event.data.name, input: event.data.input ?? {}, ok: !!event.data.ok, summary: event.data.summary ?? "" });
        }
      } else if (event.event === "done") {
        handlers.onDone(event.data);
      }
    }
  }
}

// ── Practice/prep conversations (ChatGPT-style, persisted) ──────────────────
export async function listConversations(): Promise<Conversation[]> {
  const res = await fetch(`${await base()}/conversations`, { headers: await authHeaders() });
  const data = await handle<{ conversations: Conversation[] }>(res);
  return data.conversations;
}
export async function getConversation(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
  const res = await fetch(`${await base()}/conversations/${id}`, { headers: await authHeaders() });
  return handle<{ conversation: Conversation; messages: ChatMessage[] }>(res);
}
/** profileId: a mode id, "__plain__" for the plain assistant, or undefined → active mode. */
export const PLAIN_MODE = "__plain__";
export async function createConversation(profileId?: string | null): Promise<Conversation> {
  const res = await fetch(`${await base()}/conversations`, {
    method: "POST", headers: await jsonHeaders(),
    body: JSON.stringify(profileId === undefined ? {} : { profileId }),
  });
  return handle<Conversation>(res);
}
export async function renameConversation(id: string, title: string): Promise<Conversation> {
  const res = await fetch(`${await base()}/conversations/${id}`, {
    method: "PATCH", headers: await jsonHeaders(), body: JSON.stringify({ title }),
  });
  return handle<Conversation>(res);
}
export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${await base()}/conversations/${id}`, { method: "DELETE", headers: await authHeaders() });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}
export async function streamConversationMessage(
  conversationId: string, content: string,
  opts: { images?: ChatImage[] },
  handlers: ChatStreamHandlers, signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${await base()}/conversations/${conversationId}/messages`, {
    method: "POST", headers: await jsonHeaders(),
    body: JSON.stringify({ content, images: opts.images }), signal,
  });
  await pumpSSE(res, handlers);
}

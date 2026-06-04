import type { AgendaItem, ChatChunk, ChatTurn, Company, CompanyStatus, PipelineEntry, Profile, ProfileWithFiles, ReferenceFile, Session } from "@brandon/shared";
import { getConfig } from "./bridge";

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const { apiKey } = await getConfig();
  return { Authorization: `Bearer ${apiKey}`, ...(extra ?? {}) };
}

async function jsonHeaders(): Promise<Record<string, string>> {
  return authHeaders({ "Content-Type": "application/json" });
}

async function base(): Promise<string> {
  const { serverBase } = await getConfig();
  return serverBase;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
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

export async function updateSession(id: string, input: { title?: string; endedAt?: number | null; transcript?: string | null; recap?: string | null }): Promise<Session> {
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

export interface AnthropicKeyStatus { set: boolean; preview: string | null; }

export async function getAnthropicKeyStatus(): Promise<AnthropicKeyStatus> {
  const res = await fetch(`${await base()}/settings/anthropic`, { headers: await authHeaders() });
  return handle<AnthropicKeyStatus>(res);
}

export async function setAnthropicKey(key: string | null): Promise<AnthropicKeyStatus> {
  const res = await fetch(`${await base()}/settings/anthropic`, {
    method: "PUT",
    headers: await jsonHeaders(),
    body: JSON.stringify({ anthropicApiKey: key }),
  });
  return handle<AnthropicKeyStatus>(res);
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

export interface ChatStreamHandlers {
  onText: (text: string) => void;
  onDone: (chunk: Extract<ChatChunk, { type: "done" }>) => void;
  onError: (message: string) => void;
}

export async function streamChat(
  body: { profileId: string; transcriptWindow: string; userIntent?: string; priorTurns?: ChatTurn[] },
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

export type ProfileId = string;
export type FileId = string;

export const SUPPORTED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
] as const;
export type ModelId = (typeof SUPPORTED_MODELS)[number];

export interface Profile {
  id: ProfileId;
  name: string;
  realtimePrompt: string;
  notesTemplate: string | null;
  model: ModelId;
  isActive: boolean;
  /** e.g. "Dalton Do" — user's name from the résumé, shown in the overlay footer */
  fullName: string | null;
  /** e.g. "Senior Software Engineer" — shown in the overlay footer */
  jobTitle: string | null;
  /** e.g. "DoorDash" — shown in the overlay footer */
  company: string | null;
  /** e.g. "Sunnyvale, CA" — used for weather + shown in footer */
  location: string | null;
  /** A paragraph in the user's own words. Claude mirrors its tone/vocabulary. */
  voiceSample: string | null;
  /** Per-profile interview brief: what they want next, reason for leaving, top
   *  accomplishments to lead with, hard constraints (e.g., remote-only). */
  interviewBrief: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReferenceFile {
  id: FileId;
  profileId: ProfileId;
  filename: string;
  mime: string;
  size: number;
  charCount: number;
  createdAt: number;
}

export interface ProfileWithFiles extends Profile {
  files: ReferenceFile[];
}

export interface ChatTurn {
  /** What was sent to Claude as the user message in a prior turn. */
  user: string;
  /** What Claude responded in that prior turn. */
  assistant: string;
}

export interface ChatRequest {
  profileId: ProfileId;
  transcriptWindow: string;
  userIntent?: string;
  /** Prior turns from this interview so Claude has conversation context. */
  priorTurns?: ChatTurn[];
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "done"; usage: ChatUsage }
  | { type: "error"; message: string };

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface Session {
  id: string;
  profileId: ProfileId | null;
  title: string;
  startedAt: number;
  endedAt: number | null;
  /** Full caption transcript captured during the interview. Saved on End. */
  transcript: string | null;
  /** Claude-generated bullet recap. Lazily generated when the user opens the meeting. */
  recap: string | null;
  /** Per-interview target company (set in the pre-interview modal). */
  targetCompany: string | null;
  /** Per-interview job description text (set in the pre-interview modal). */
  jobDescription: string | null;
}

export type CompanyStatus = "active" | "paused" | "rejected" | "offer";
export const COMPANY_STATUSES: readonly CompanyStatus[] = ["active", "paused", "rejected", "offer"];

export interface Company {
  id: string;
  name: string;
  status: CompanyStatus;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Aggregated pipeline data returned by GET /companies. */
export interface PipelineEntry extends Company {
  /** Number of sessions linked to this company. */
  sessionCount: number;
  /** Most recent session's startedAt (ms). null if no sessions yet. */
  lastContactAt: number | null;
  /** Stage parsed from the most recent session's title — e.g. "Recruiter screen", "Tech interview". */
  latestStage: string | null;
  /** Title of the most recent session (for "Tech interview · Stripe" → display). */
  latestSessionTitle: string | null;
  /** Sessions in chronological-descending order, slim shape for the pipeline UI. */
  sessions: Array<{ id: string; title: string; startedAt: number; endedAt: number | null }>;
  /** Bullet items parsed out of the latest recap's `## Next steps` section. */
  nextSteps: string[];
}

/** A single actionable next-step extracted from an interview recap. */
export interface NextStepItem {
  /** What needs to happen, in the user's voice. e.g. "Send writing samples". */
  action: string;
  /** ISO date (YYYY-MM-DD) when this is due. null if no date was mentioned. */
  dueDate: string | null;
  /** "candidate" | "interviewer" | "recruiter" | "other" — who's responsible. */
  owner: string | null;
}

/** A single item on the calendar/agenda — derived from a session's next_steps_json. */
export interface AgendaItem extends NextStepItem {
  /** Stable id: `<sessionId>-<index>`. */
  id: string;
  sessionId: string;
  sessionTitle: string;
  companyId: string | null;
  companyName: string | null;
  /** Time when the source meeting occurred (for context). */
  meetingAt: number;
}

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
] as const;

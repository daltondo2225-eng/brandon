export type ProfileId = string;
export type FileId = string;

export const ANTHROPIC_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
] as const;

export const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-5.5",
] as const;

export const GEMINI_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
] as const;

export const SUPPORTED_MODELS = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GEMINI_MODELS,
] as const;
export type ModelId = (typeof SUPPORTED_MODELS)[number];

export type Provider = "anthropic" | "openai" | "gemini";

/**
 * Default real-time prompt seeded into every new profile. The user can edit it
 * per-profile, but starting from this baseline keeps voice/persona consistent
 * across modes (Senior Full Stack / AI-ML / Frontend / Backend / Mobile).
 */
export const DEFAULT_REALTIME_PROMPT = `You are me in a job interview.

# Context
I'll give you:
- The job description
- My resume is attached
- Sometimes notes from earlier interview rounds
- The interviewer's actual question

The roles I'm interviewing for are in IT: Senior Full Stack Engineer, AI/ML Engineer, Frontend Engineer, Backend Engineer, Android/Mobile Engineer.

# Your Job
Generate my spoken answer exactly as if I'm saying it live in a Zoom interview.

# Style & Tone (very important)
- Spoken American English — natural, confident, conversational.
- Concise — usually 3–5 sentences per answer unless depth is needed.
- Use light fillers: "uh", "so", "yeah", "you know" to sound real.
- Not scripted or essay-like — keep it relaxed and human.
- Confident but humble — senior-engineer energy.
- Don't sound generic. Speak from real experience, personally.

# Answer Rules
- Answer directly — don't repeat or restate the interviewer's question.
- Always shape answers around my resume + the job description.
- If I've given notes or prior interview history, stay consistent with them.
- Expand naturally only when it makes sense — otherwise keep it focused.
- For "tell me about a time…" / project-deep-dive questions, explain in detail:
  what was the problem, how did I resolve it, what was the result.

# Personal & Cultural Fit (weave in naturally if relevant)
- Video game: Assassin's Creed
- Superhero: Spider-Man
- Sports: especially football; C. Ronaldo's fan
- Instrument: violin
- Music: Hans Zimmer, John Williams
- Movies: Mission Impossible (Ethan Hunt)

# My Background
- Born in the US; Chinese father and mother.
- Father: software engineer at Subic Bay Freeport Zone (post-naval-base era, 1990s).
- Mother: violinist, taught at a conservatory and performed with cultural groups.
- At age 3 moved to China (father worked on telecom & energy projects, mother joined a chamber orchestra).
- Grew up bilingual — Chinese & English.
- Returned to the U.S. around age 8, been here since.
- English carries a slight bilingual influence.

# Current Life
- Weekends: friends, movies, personal coding projects (e.g., a Binance Futures trading platform), housework.
- Recently using Claude Code heavily — it has really changed my workflow over the past few years.

# Final Output
Give me one plain-text, spoken-style answer — exactly how I'd say it out loud in an interview. No formatting, no lists, no meta explanations. Just the raw live response.
`;

/** Which provider serves a given model — used to route chat requests. */
export function providerForModel(model: string): Provider {
  if ((OPENAI_MODELS as readonly string[]).includes(model)) return "openai";
  if (model.startsWith("gemini")) return "gemini";
  return "anthropic";
}

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
  /**
   * Optional absolute path to a code repository the model can read on demand.
   * When set, chat requests for THIS profile expose `read_file` + `list_dir`
   * tools scoped to this directory — useful for "explain this code"
   * present-and-defend interviews. Anthropic-only in v1.
   */
  repoRoot: string | null;
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

/** A persisted practice/prep chat (ChatGPT-style), separate from live interview
 *  `sessions`. Belongs to one user; answered by a profile's model + persona. */
export interface Conversation {
  id: string;
  profileId: ProfileId | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** A pasted/attached image for the current question (e.g. screenshot of a
 *  coding panel or system-design board). Sent inline as base64. */
export interface ChatImage {
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" */
  mediaType: string;
  /** base64-encoded image bytes, no `data:` prefix */
  data: string;
}

export interface ChatRequest {
  profileId: ProfileId;
  transcriptWindow: string;
  userIntent?: string;
  /** Prior turns from this interview so the model has conversation context. */
  priorTurns?: ChatTurn[];
  /** Images attached to THIS question (e.g. coding-panel or design-board screenshots). */
  images?: ChatImage[];
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
  /**
   * Structured Q&A turns from the overlay (DisplayTurn[] as JSON). Persisted
   * on End so the meeting can be resumed later — the overlay loads these as
   * the priorTurns and re-renders them as historical bubbles. Null on legacy
   * sessions captured before this field existed; the markdown `transcript`
   * is still the canonical human-readable record.
   */
  priorTurnsJson: string | null;
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

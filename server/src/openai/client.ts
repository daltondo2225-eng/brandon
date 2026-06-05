import OpenAI from "openai";
import type { ChatImage, ChatTurn, ChatUsage, ProfileWithFiles } from "@brandon/shared";
import { config } from "../config.js";
import { getOpenAIKey } from "../db/settings.js";
import { buildPrompt } from "../claude/prompt.js";

let _client: OpenAI | null = null;
let _clientKey = "";
function client(): OpenAI {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error(
      "OpenAI API key not set. Open Brandon → Settings (gear icon in the sidebar footer) and paste your sk-… key.",
    );
  }
  if (!_client || _clientKey !== key) {
    _client = new OpenAI({ apiKey: key });
    _clientKey = key;
  }
  return _client;
}

export interface StreamInput {
  profile: ProfileWithFiles;
  transcriptWindow: string;
  userIntent?: string;
  priorTurns?: ChatTurn[];
  images?: ChatImage[];
  sessionContext?: { targetCompany: string | null; jobDescription: string | null };
  onText: (text: string) => void;
  onDone: (usage: ChatUsage) => void;
  /** Accepted but ignored — code tools are Anthropic-only in this version. */
  onTool?: (event: { name: string; input: Record<string, unknown>; ok: boolean; summary: string }) => void;
}

// Newer OpenAI models (o-series reasoning models AND the GPT-5 line) reject
// `max_tokens` (require `max_completion_tokens`) and only accept the default
// temperature (so we must omit `temperature` entirely). Verified live against
// gpt-5.5. Only legacy GPT-4.x/4o take the classic params.
function isRestrictedParamModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5/.test(model);
}

/**
 * Stream a completion from OpenAI, mirroring streamCompletion in claude/client.ts
 * so chat.ts can call either interchangeably. buildPrompt() produces a
 * provider-neutral cache-block system array; we flatten it into one string for
 * OpenAI which has no prompt-cache block concept.
 */
export async function streamCompletion(input: StreamInput): Promise<void> {
  const built = buildPrompt(
    { ...input, sessionContext: input.sessionContext },
    { extendedCache: config.extendedCache },
  );

  const systemText = built.system.map((b) => b.text).join("\n\n");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemText },
  ];
  for (const t of input.priorTurns ?? []) {
    if (t.user) messages.push({ role: "user", content: t.user });
    if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
  }
  // Pasted images attach as image_url parts alongside the text.
  const images = input.images ?? [];
  if (images.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: built.userMessage },
        ...images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        })),
      ],
    });
  } else {
    messages.push({ role: "user", content: built.userMessage });
  }

  const model = input.profile.model;
  const restricted = isRestrictedParamModel(model);

  const stream = await client().chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(restricted ? {} : { temperature: 0.7 }),
    ...(restricted ? { max_completion_tokens: 2048 } : { max_tokens: 1024 }),
  });

  let promptTokens = 0;
  let completionTokens = 0;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) input.onText(delta);
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0;
      completionTokens = chunk.usage.completion_tokens ?? 0;
    }
  }

  input.onDone({
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
}

// ─── Utility calls (recap, identity extraction) ─────────────────────────────
//
// These match the shapes of the Claude utility calls in claude/client.ts so
// the routes can swap between providers without touching their own logic.
// Model defaults to gpt-5.5 — restricted-param family, needs
// max_completion_tokens and no temperature.
const UTILITY_MODEL = "gpt-5.5";

export interface ExtractedIdentity {
  fullName: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

/** OpenAI port of extractIdentityFromResume from claude/client.ts. */
export async function extractIdentityFromResume(resumeText: string): Promise<ExtractedIdentity> {
  const system =
    "You read résumé text and extract the candidate's identity. Return ONLY a JSON " +
    "object with keys fullName, jobTitle, company, location. The name is the person's " +
    "full name as written at the top of the résumé. Use the most recent (currently-held) " +
    "role for jobTitle/company, and that role's city for location. If a field is unknown, " +
    "set it to null. Example: {\"fullName\":\"Dalton Do\",\"jobTitle\":\"Senior Software " +
    "Engineer\",\"company\":\"DoorDash\",\"location\":\"Sunnyvale, CA\"}. No prose, no markdown.";
  const resp = await client().chat.completions.create({
    model: UTILITY_MODEL,
    max_completion_tokens: 240,
    messages: [
      { role: "system", content: system },
      { role: "user", content: resumeText.slice(0, 30000) },
    ],
  });
  const text = resp.choices[0]?.message?.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { fullName: null, jobTitle: null, company: null, location: null };
  try {
    const parsed = JSON.parse(match[0]) as Partial<ExtractedIdentity>;
    const cleanStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      fullName: cleanStr(parsed.fullName),
      jobTitle: cleanStr(parsed.jobTitle),
      company: cleanStr(parsed.company),
      location: cleanStr(parsed.location),
    };
  } catch {
    return { fullName: null, jobTitle: null, company: null, location: null };
  }
}

export interface RecapResult {
  title: string | null;
  recap: string;
  nextSteps: Array<{ action: string; dueDate: string | null; owner: string | null }>;
}

/** OpenAI port of generateRecap from claude/client.ts. Same prompt + parsing,
 *  switched to the chat-completions endpoint with the GPT-5 restricted params. */
export async function generateRecap(input: {
  transcript: string;
  targetCompany?: string | null;
  jobDescription?: string | null;
}): Promise<RecapResult> {
  const transcript = input.transcript ?? "";
  if (!transcript.trim()) {
    return { title: null, recap: "(No transcript captured for this session.)", nextSteps: [] };
  }
  const companyHint = input.targetCompany?.trim();
  const jdHint = input.jobDescription?.trim();
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const todayWeekday = today.toLocaleDateString("en-US", { weekday: "long" });

  const system =
    "You are an interview recap writer. Given a raw live-captions transcript of a job " +
    "interview (plus optional company + job description context), output exactly three things " +
    "in order, with NO other prose, NO greetings, NO trailing commentary:\n\n" +
    "1. A single line starting with `TITLE: ` followed by a 3-7 word natural label for the " +
    "meeting. Format examples: `Intro call with Mercury`, `Recruiter screen — Stripe`, " +
    "`Tech interview · Datadog`, `Hiring manager chat with Anthropic`. Pick the format that " +
    "fits the conversation type (intro/recruiter/tech/HM/system-design/onsite/etc). If a " +
    "target company was provided AND the transcript confirms it, use that name; otherwise " +
    "infer from what was actually said. Do NOT invent a company name not in the transcript " +
    "or hints. If genuinely unknown, write `TITLE: Untitled interview`.\n\n" +
    "2. A blank line, then the Markdown body in EXACTLY this structure:\n\n" +
    "## Summary\n2-3 sentences describing what the conversation was about.\n\n" +
    "## Key questions asked\n- (3 to 6 bullets capturing the interviewer's main questions)\n\n" +
    "## Topics covered\n- (3 to 5 bullets of technical/behavioural topics)\n\n" +
    "## Next steps\n- (Concrete follow-ups from this conversation: who said they'd do what, " +
    "when, deliverables promised, materials to send, scheduling commitments, decisions still " +
    "pending. 2 to 5 bullets. If the transcript doesn't mention specific next steps, write " +
    "`- (no explicit next steps mentioned)` plus 1-2 sensible suggestions in italics.)\n\n" +
    "## Suggested follow-ups\n- (2 to 4 actionable bullets the candidate should do themselves)\n\n" +
    "3. A blank line, then a fenced JSON code block tagged `next-steps-json` containing a " +
    "JSON array that mirrors the `## Next steps` section in structured form. Format:\n\n" +
    "```next-steps-json\n[\n" +
    "  { \"action\": \"Send portfolio link\", \"dueDate\": \"2026-06-09\", \"owner\": \"candidate\" },\n" +
    "  { \"action\": \"Recruiter follow-up email\", \"dueDate\": null, \"owner\": \"recruiter\" }\n" +
    "]\n```\n\n" +
    "Rules for the JSON block:\n" +
    `- Today is ${todayIso} (${todayWeekday}). Resolve relative phrases ("by Tuesday", "next Friday", "end of next week", "tomorrow") into ISO dates (YYYY-MM-DD).\n` +
    "- If no due date was discussed for an item, set `dueDate: null`.\n" +
    "- `owner` must be one of `candidate`, `interviewer`, `recruiter`, or `other`. Default to `candidate` for items the candidate must do.\n" +
    "- `action` is a short imperative phrase (≤8 words), not a full sentence. Strip dates/owner from `action` itself.\n" +
    "- One entry per `## Next steps` bullet, in the same order. If next steps section was `(no explicit next steps mentioned)`, output `[]`.\n" +
    "- NEVER invent dates. If the transcript doesn't specify when, `dueDate` is null.\n\n" +
    "If the transcript is too short to recap meaningfully, output `TITLE: Short conversation` " +
    "then `_Transcript too short for a meaningful recap._` and an empty JSON block, then stop. " +
    "Do NOT invent content that isn't present in the transcript.";

  const contextHint = [
    companyHint ? `Target company: ${companyHint}` : null,
    jdHint ? `Job description excerpt:\n${jdHint.slice(0, 1500)}` : null,
  ].filter(Boolean).join("\n\n");

  const userMessage = contextHint
    ? `${contextHint}\n\n---\n\nTranscript:\n${transcript.slice(0, 40000)}`
    : transcript.slice(0, 40000);

  const resp = await client().chat.completions.create({
    model: UTILITY_MODEL,
    max_completion_tokens: 1100,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });
  const out = (resp.choices[0]?.message?.content ?? "").trim();

  const titleMatch = out.match(/^TITLE:\s*(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const afterTitle = titleMatch ? out.slice(out.indexOf("\n", titleMatch.index ?? 0) + 1).trim() : out;

  const jsonBlockRe = /```\s*next-steps-json\s*\n([\s\S]*?)```/i;
  const jsonMatch = afterTitle.match(jsonBlockRe);
  const recap = afterTitle.replace(jsonBlockRe, "").trim();
  let nextSteps: RecapResult["nextSteps"] = [];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim()) as unknown;
      if (Array.isArray(parsed)) {
        nextSteps = parsed
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const o = item as Record<string, unknown>;
            const action = typeof o.action === "string" ? o.action.trim() : "";
            if (!action) return null;
            const due = typeof o.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate) ? o.dueDate : null;
            const own = typeof o.owner === "string" ? o.owner.trim().toLowerCase() : null;
            return { action, dueDate: due, owner: own };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      }
    } catch { /* keep nextSteps = [] */ }
  }

  return { title, recap, nextSteps };
}

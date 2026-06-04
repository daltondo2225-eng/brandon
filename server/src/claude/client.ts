import Anthropic from "@anthropic-ai/sdk";
import type { ChatImage, ChatTurn, ChatUsage, ProfileWithFiles } from "@brandon/shared";
import { config } from "../config.js";
import { getAnthropicKey } from "../db/settings.js";
import { buildPrompt } from "./prompt.js";

const EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11";

let _client: Anthropic | null = null;
let _clientKey: string = "";
function client(): Anthropic {
  const key = getAnthropicKey();
  if (!key) {
    throw new Error(
      "Anthropic API key not set. Open Brandon → Settings (gear icon in the sidebar footer) and paste your sk-ant-… key.",
    );
  }
  // Rebuild client if the key changed (user updated it via Settings).
  if (!_client || _clientKey !== key) {
    _client = new Anthropic({ apiKey: key });
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
}

export interface ExtractedIdentity {
  fullName: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

/**
 * Pull the user's full name, current job title, company, and location out of
 * the résumé text with a small single-turn Claude call. Returns null fields
 * when not found.
 */
export async function extractIdentityFromResume(resumeText: string): Promise<ExtractedIdentity> {
  const system =
    "You read résumé text and extract the candidate's identity. Return ONLY a JSON " +
    "object with keys fullName, jobTitle, company, location. The name is the person's " +
    "full name as written at the top of the résumé. Use the most recent (currently-held) " +
    "role for jobTitle/company, and that role's city for location. If a field is unknown, " +
    'set it to null. Example: {"fullName":"Dalton Do","jobTitle":"Senior Software ' +
    'Engineer","company":"DoorDash","location":"Sunnyvale, CA"}. No prose, no markdown.';
  const resp = await client().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 240,
    system,
    messages: [{ role: "user", content: resumeText.slice(0, 30000) }],
  });
  const text = resp.content.map((c) => (c.type === "text" ? c.text : "")).join("");
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
  /** Short human-readable title — e.g. "Intro call with Mercury", "Tech interview · Stripe". */
  title: string | null;
  /** Markdown recap body. */
  recap: string;
  /**
   * Structured next-steps with resolved ISO dates (when present in the
   * transcript). Used by the calendar/agenda view. May be empty.
   */
  nextSteps: Array<{ action: string; dueDate: string | null; owner: string | null }>;
}

/**
 * Generate a short Markdown recap AND a concise title from a meeting transcript.
 * The title is produced inline (single Claude call) and parsed off the leading
 * `TITLE:` line. Includes a "Next steps" section so the candidate has explicit
 * follow-up items.
 */
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
  // Today's date — passed into the prompt so Claude can resolve relative phrases
  // like "by Tuesday" / "next Friday" / "end of next week" into ISO dates.
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

  const resp = await client().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1100,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  const out = resp.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();

  // Parse off the leading TITLE line. Tolerate missing/malformed title by
  // falling back to null (caller keeps the existing session title).
  const titleMatch = out.match(/^TITLE:\s*(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const afterTitle = titleMatch ? out.slice(out.indexOf("\n", titleMatch.index ?? 0) + 1).trim() : out;

  // Strip the fenced ```next-steps-json ... ``` block out of the markdown so it
  // doesn't render in the recap UI; keep the parsed JSON separately.
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
    } catch { /* keep nextSteps = [] on malformed JSON */ }
  }

  return { title, recap, nextSteps };
}

export async function streamCompletion(input: StreamInput): Promise<void> {
  const built = buildPrompt(
    { ...input, sessionContext: input.sessionContext },
    { extendedCache: config.extendedCache },
  );

  // Build a proper multi-turn message list: prior turns (verbatim) + the new user turn.
  const messages: Anthropic.MessageParam[] = [];
  for (const t of input.priorTurns ?? []) {
    if (t.user) messages.push({ role: "user", content: t.user });
    if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
  }
  // Attach any pasted images (screenshots of the coding/design panel) as image
  // blocks alongside the text of the current question.
  const images = input.images ?? [];
  if (images.length) {
    const content: Anthropic.ContentBlockParam[] = [
      { type: "text", text: built.userMessage },
      ...images.map((img): Anthropic.ImageBlockParam => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: img.data,
        },
      })),
    ];
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: built.userMessage });
  }

  const stream = await client().messages.stream(
    {
      model: input.profile.model,
      max_tokens: 1024,
      system: built.system,
      messages,
    },
    config.extendedCache ? { headers: { "anthropic-beta": EXTENDED_CACHE_BETA } } : undefined,
  );

  stream.on("text", (delta) => input.onText(delta));

  const final = await stream.finalMessage();
  input.onDone({
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
    cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
  });
}

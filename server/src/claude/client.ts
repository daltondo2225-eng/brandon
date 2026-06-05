import Anthropic from "@anthropic-ai/sdk";
import type { ChatImage, ChatTurn, ChatUsage, ProfileWithFiles } from "@brandon/shared";
import { config } from "../config.js";
import { getAnthropicKey } from "../db/settings.js";
import { buildPrompt } from "./prompt.js";
import { CODE_TOOL_DEFS, runCodeTool } from "../tools/code.js";

const EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11";

let _client: Anthropic | null = null;
let _clientKey: string = "";
function client(): Anthropic {
  const key = getAnthropicKey();
  if (!key) {
    throw new Error(
      "The server is missing its Anthropic API key — please contact the administrator.",
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
  /** Pasted/attached images for the current question (screenshots of the
   *  coding panel, system-design board, etc.). Sent inline as base64 blocks. */
  images?: ChatImage[];
  sessionContext?: { targetCompany: string | null; jobDescription: string | null };
  /** The owning user's global defaults (interview brief + voice sample). */
  defaults?: { defaultInterviewBrief: string; defaultVoiceSample: string };
  /** Plain assistant mode — generic helper, no interview persona. */
  plain?: boolean;
  onText: (text: string) => void;
  onDone: (usage: ChatUsage) => void;
  /**
   * Optional callback fired when the model invokes a code-access tool
   * (read_file / list_dir). The renderer surfaces these as "🔍 reading …"
   * progress lines above the streaming response.
   */
  onTool?: (event: {
    name: string;
    input: Record<string, unknown>;
    ok: boolean;
    summary: string;
  }) => void;
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
    { extendedCache: config.extendedCache, plain: input.plain },
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

  const repoRoot = input.profile.repoRoot?.trim() || null;
  const baseHeaders = config.extendedCache ? { "anthropic-beta": EXTENDED_CACHE_BETA } : undefined;

  // Token usage accumulates across the agentic loop's multiple round-trips.
  const usage: ChatUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // --- Simple text-only mode (no repoRoot) ---------------------------------
  // Keeps the fast path identical to the original implementation; only
  // requests that explicitly opt into code tools take the agentic loop.
  if (!repoRoot) {
    const stream = await client().messages.stream(
      {
        model: input.profile.model,
        max_tokens: 1024,
        system: built.system,
        messages,
      },
      baseHeaders ? { headers: baseHeaders } : undefined,
    );
    stream.on("text", (delta) => input.onText(delta));
    const final = await stream.finalMessage();
    input.onDone({
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
    });
    return;
  }

  // --- Agentic loop (repoRoot set) -----------------------------------------
  // Model can call read_file / list_dir; we run them locally and feed the
  // result back as a tool_result block, then loop until the model emits a
  // pure-text response (no further tool calls). Hard cap on iterations to
  // avoid pathological behaviour.
  const tools = CODE_TOOL_DEFS as unknown as Anthropic.Messages.Tool[];
  const MAX_ITERATIONS = 8;
  let iter = 0;

  while (iter < MAX_ITERATIONS) {
    iter++;
    const stream = await client().messages.stream(
      {
        model: input.profile.model,
        max_tokens: 2048,
        system: built.system,
        messages,
        tools,
      },
      baseHeaders ? { headers: baseHeaders } : undefined,
    );
    // Only forward text deltas on the FINAL turn (no tool_use). For
    // tool-use turns we still need to drain the stream but the text
    // before a tool_use is usually the model's "let me check that" filler
    // and is usually short — forward it so the user sees progress.
    stream.on("text", (delta) => input.onText(delta));

    const final = await stream.finalMessage();
    usage.inputTokens += final.usage.input_tokens;
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheCreationInputTokens += final.usage.cache_creation_input_tokens ?? 0;
    usage.cacheReadInputTokens += final.usage.cache_read_input_tokens ?? 0;

    // If the model is done (stop_reason: end_turn / stop_sequence), we're out.
    if (final.stop_reason !== "tool_use") break;

    // Otherwise, collect tool_use blocks, execute them, append both the
    // assistant turn (verbatim) and a user turn with tool_result blocks.
    const toolUses = final.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );
    if (toolUses.length === 0) break; // defensive: stop_reason said tool_use but no blocks

    // Append the assistant's full content (text + tool_use) to the conversation.
    messages.push({ role: "assistant", content: final.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const res = await runCodeTool(tu.name, tu.input, repoRoot);
      let summary: string;
      if (res.ok) {
        const r = res.result as Record<string, unknown>;
        if (tu.name === "read_file") {
          summary = `read ${r.path}:${r.startLine}-${r.endLine}${r.truncated ? " (truncated)" : ""}`;
        } else if (tu.name === "list_dir") {
          const n = Array.isArray(r.entries) ? r.entries.length : 0;
          summary = `list_dir ${r.path || "/"} (${n} entries)`;
        } else {
          summary = tu.name;
        }
      } else {
        summary = `${tu.name} FAILED: ${res.error}`;
      }
      input.onTool?.({
        name: tu.name,
        input: (tu.input ?? {}) as Record<string, unknown>,
        ok: res.ok,
        summary,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: res.ok
          ? JSON.stringify(res.result)
          : `ERROR: ${res.error}`,
        is_error: !res.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (iter >= MAX_ITERATIONS) {
    input.onText("\n\n_[code-tool loop hit max iterations; stopping]_");
  }

  input.onDone(usage);
}

import OpenAI from "openai";
import type { ChatImage, ChatTurn, ChatUsage, ProfileWithFiles } from "@brandon/shared";
import { config } from "../config.js";
import { getGeminiKey } from "../db/settings.js";
import { buildPrompt } from "../claude/prompt.js";

// Google exposes Gemini through an OpenAI-compatible endpoint, so we reuse the
// OpenAI SDK pointed at Gemini's base URL instead of pulling in a second SDK.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

let _client: OpenAI | null = null;
let _clientKey = "";
function client(): OpenAI {
  const key = getGeminiKey();
  if (!key) {
    throw new Error(
      "The server is missing its Google Gemini API key — please contact the administrator.",
    );
  }
  if (!_client || _clientKey !== key) {
    _client = new OpenAI({ apiKey: key, baseURL: GEMINI_BASE_URL });
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
  defaults?: { defaultInterviewBrief: string; defaultVoiceSample: string };
  /** Plain assistant mode — generic helper, no interview persona. */
  plain?: boolean;
  onText: (text: string) => void;
  onDone: (usage: ChatUsage) => void;
  /** Accepted but ignored — code tools are Anthropic-only in this version. */
  onTool?: (event: { name: string; input: Record<string, unknown>; ok: boolean; summary: string }) => void;
}

export async function streamCompletion(input: StreamInput): Promise<void> {
  const built = buildPrompt(
    { ...input, sessionContext: input.sessionContext },
    { extendedCache: config.extendedCache, plain: input.plain },
  );

  const systemText = built.system.map((b) => b.text).join("\n\n");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemText },
  ];
  for (const t of input.priorTurns ?? []) {
    if (t.user) messages.push({ role: "user", content: t.user });
    if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
  }
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

  const stream = await client().chat.completions.create({
    model: input.profile.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens: 1024,
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

import OpenAI from "openai";
import type { ChatImage, ChatTurn, ChatUsage, ProfileWithFiles } from "@brandon/shared";
import { config } from "../config.js";
import { getGeminiKey } from "../db/settings.js";
import { buildPrompt } from "../claude/prompt.js";

// Google exposes Gemini through an OpenAI-compatible endpoint, so we reuse the
// OpenAI SDK pointed at Gemini's base URL instead of pulling in a second SDK.
// Verified live: gemini-3.1-pro-preview / gemini-3.5-flash stream correctly with
// the standard chat-completions shape (temperature + max_tokens both accepted).
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

let _client: OpenAI | null = null;
let _clientKey = "";
function client(): OpenAI {
  const key = getGeminiKey();
  if (!key) {
    throw new Error(
      "Google Gemini API key not set. Open Brandon → Settings (gear icon in the sidebar footer) and paste your AIza… key.",
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
  onText: (text: string) => void;
  onDone: (usage: ChatUsage) => void;
}

/**
 * Stream a completion from Gemini via its OpenAI-compatible API. Mirrors the
 * Anthropic/OpenAI streamCompletion so the chat route can call any of them
 * interchangeably. Flattens buildPrompt()'s cache-block system array into one
 * system message (Gemini has no prompt-cache block concept).
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
  // Attach pasted images (screenshots of the coding/design panel) as image_url parts.
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

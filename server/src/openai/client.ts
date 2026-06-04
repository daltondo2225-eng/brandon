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
}

// Newer OpenAI models (o-series reasoning models AND the GPT-5 line) reject
// `max_tokens` (require `max_completion_tokens`) and only accept the default
// temperature (so we must omit `temperature` entirely). Verified live against
// gpt-5.5: max_tokens → 400, temperature:0.7 → 400. Only legacy GPT-4.x/4o
// take the classic params. Detect the "restricted" family by prefix.
function isRestrictedParamModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5/.test(model);
}

/**
 * Stream a completion from OpenAI, mirroring the Anthropic streamCompletion so
 * the chat route can call either interchangeably. The shared buildPrompt()
 * produces provider-neutral content; we flatten its cache-block system array
 * into a single system string (OpenAI has no prompt-cache block concept) and
 * map prior turns to the chat-completions message format.
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

  const model = input.profile.model;
  const restricted = isRestrictedParamModel(model);

  const stream = await client().chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // Restricted models (o-series, gpt-5*) only allow the default temperature
    // and require max_completion_tokens; older models take temperature + max_tokens.
    ...(restricted ? {} : { temperature: 0.7 }),
    ...(restricted ? { max_completion_tokens: 2048 } : { max_tokens: 1024 }),
  });

  let promptTokens = 0;
  let completionTokens = 0;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) input.onText(delta);
    // Final chunk carries usage when stream_options.include_usage is set.
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

import { config } from "./config.js";

// Single source of truth for which origins may call the API. Used by both the
// @fastify/cors registration and the manual SSE CORS-header copy in chat.ts
// (the SSE path writes headers directly via reply.raw and bypasses the plugin).
const ALLOWED = new Set(config.allowedOrigins);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true;            // Electron file:// renderer
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true; // local dev
  return ALLOWED.has(origin);
}

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { config } from "./config.js";
import { isAllowedOrigin } from "./cors.js";
import "./db/client.js"; // initialize schema before routes load
import { bootstrap } from "./db/bootstrap.js";
import { verifyToken } from "./auth/jwt.js";
import { getUserById } from "./db/users.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerWeatherRoutes } from "./routes/weather.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerAgendaRoutes } from "./routes/agenda.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSettingsRoutes } from "./routes/settings.js";

// First-boot: ensure super-admin exists and owns any pre-existing rows.
bootstrap();

const app = Fastify({ logger: { level: "info" } });

await app.register(sensible);

// CORS allowlist (NOT origin:true — this server is now reachable beyond loopback).
// The Electron renderer loads from file:// (Origin "null") or a dev localhost URL.
await app.register(cors, {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
});

await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

// Public routes need no token; everything else requires a valid JWT whose user
// still exists and isn't disabled. The DB is the source of truth for role/status
// (token claims can be stale), so approve/disable take effect immediately.
const PUBLIC_PATHS = new Set(["/health", "/auth/signup", "/auth/login"]);
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (PUBLIC_PATHS.has(path)) return;

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  let userId: string;
  try {
    const payload = await verifyToken(token);
    userId = payload.sub;
  } catch (err) {
    // Log auth rejections (missing/expired/forged token) for debugging — never
    // logs the token itself, only its length and the verify error.
    req.log.warn(
      { method: req.method, path, tokenLen: token.length, reason: (err as Error).message },
      "auth rejected",
    );
    return reply.unauthorized("Invalid or missing token");
  }
  const user = getUserById(userId);
  if (!user) return reply.unauthorized("Account not found");
  if (user.status === "disabled") return reply.unauthorized("Account disabled");
  req.user = { id: user.id, email: user.email, role: user.role, status: user.status };
});

app.get("/health", async () => ({ ok: true }));

await registerAuthRoutes(app);
await registerAdminRoutes(app);
await registerProfileRoutes(app);
await registerFileRoutes(app);
await registerSessionRoutes(app);
await registerCompanyRoutes(app);
await registerAgendaRoutes(app);
await registerSettingsRoutes(app);
await registerChatRoutes(app);
await registerConversationRoutes(app);
await registerWeatherRoutes(app);

app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`Brandon server listening on http://${config.host}:${config.port}`);
});

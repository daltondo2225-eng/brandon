import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { config } from "./config.js";
import "./db/client.js"; // initialize schema before routes load
import { registerChatRoutes } from "./routes/chat.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerAgendaRoutes } from "./routes/agenda.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSettingsRoutes } from "./routes/settings.js";

const app = Fastify({ logger: { level: "info" } });

await app.register(sensible);
await app.register(cors, { origin: true, credentials: true });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health") return;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== config.apiKey) {
    return reply.unauthorized("Invalid or missing API key");
  }
});

app.get("/health", async () => ({ ok: true }));

await registerProfileRoutes(app);
await registerFileRoutes(app);
await registerSessionRoutes(app);
await registerCompanyRoutes(app);
await registerAgendaRoutes(app);
await registerSettingsRoutes(app);
await registerChatRoutes(app);

app.listen({ port: config.port, host: "127.0.0.1" }).then(() => {
  const addr = app.server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : config.port;
  // Publish the resolved port so the desktop shell can find us without a fixed
  // PORT (the API key is published the same way in config.ts).
  try {
    writeFileSync(resolve(config.dataDir, "brandon-port"), String(boundPort), "utf8");
  } catch { /* non-fatal — prod passes PORT explicitly anyway */ }
  app.log.info(`Brandon server listening on http://127.0.0.1:${boundPort}`);
  app.log.info(`Local API key: ${config.apiKey}`);
});

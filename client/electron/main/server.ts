import { ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "electron";

// Server child handle (production builds only).
let child: ChildProcess | null = null;
let logPath: string = "";
function log(line: string): void {
  if (!logPath) return;
  try { appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}

async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`, { method: "GET" });
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms: ${lastErr}`);
}

export interface ServerHandle { baseUrl: string; apiKey: string; }

/**
 * Start the bundled Node server as an Electron-as-Node child process.
 *
 * In dev (when ELECTRON_RENDERER_URL is set OR app.isPackaged is false) this
 * is a no-op: the developer is running `npm run dev:server` externally and
 * the Electron renderer talks to that. The returned handle reads the
 * dev .env to find that server's key + port.
 */
export async function startServer(): Promise<ServerHandle> {
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  logPath = resolve(dataDir, "server.log");
  writeFileSync(logPath, `--- server start ${new Date().toISOString()} ---\n`);

  if (!app.isPackaged) {
    // Dev: read repo .env that the dev server uses.
    const devEnvPath = resolve(__dirname, "..", "..", "..", ".env");
    let apiKey = ""; let port = 8787;
    if (existsSync(devEnvPath)) {
      for (const line of readFileSync(devEnvPath, "utf8").split(/\r?\n/)) {
        const [k, v] = line.split("=");
        if (k === "BRANDON_API_KEY") apiKey = (v ?? "").trim();
        if (k === "PORT") port = Number((v ?? "").trim()) || port;
      }
    }
    return { baseUrl: `http://127.0.0.1:${port}`, apiKey };
  }

  // Packaged: spawn the staged server (extraResources -> resources/server).
  const serverEntry = resolve(process.resourcesPath, "server", "dist", "index.mjs");
  if (!existsSync(serverEntry)) {
    throw new Error(`Bundled server not found at ${serverEntry}. Was \`npm run package:server\` executed before electron-builder?`);
  }
  const port = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    BRANDON_DATA_DIR: dataDir,
    PORT: String(port),
  };
  log(`spawning server: node ${serverEntry}  (port=${port}, dataDir=${dataDir})`);
  child = spawn(process.execPath, [serverEntry], {
    env,
    cwd: resolve(process.resourcesPath, "server"),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (b: Buffer) => log(`stdout: ${b.toString("utf8").trim()}`));
  child.stderr?.on("data", (b: Buffer) => log(`stderr: ${b.toString("utf8").trim()}`));
  child.on("exit", (code, signal) => { log(`server exited code=${code} signal=${signal}`); child = null; });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Packaged cold-start can take ~30-45s on the first launch (openai SDK +
    // node:sqlite + Fastify route registration loaded from cold disk). 90s
    // gives ample slack; subsequent launches benefit from the OS file cache.
    await waitForHealth(baseUrl, 90000);
  } catch (e) {
    log(`health check failed: ${(e as Error).message}`);
    throw e;
  }

  // Server writes its generated API key to BRANDON_DATA_DIR/brandon-api-key
  // on first run; we read it back so the renderer can authenticate.
  const keyFile = resolve(dataDir, "brandon-api-key");
  let apiKey = "";
  if (existsSync(keyFile)) apiKey = readFileSync(keyFile, "utf8").trim();
  if (!apiKey) {
    throw new Error(`Server started but no API key file at ${keyFile}`);
  }
  log(`server healthy on ${baseUrl}`);
  return { baseUrl, apiKey };
}

export function stopServer(): void {
  if (!child) return;
  log(`stopping server pid=${child.pid}`);
  try { child.kill(); } catch { /* ignore */ }
  child = null;
}

import { ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "electron";

const DEBUG_LOG = resolve(process.cwd(), "captions-debug.log");
try { writeFileSync(DEBUG_LOG, `--- captions debug ${new Date().toISOString()} ---\n`); } catch { /* ignore */ }
function dbg(line: string): void {
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}

export type CaptionsEvent =
  | { type: "status"; captionsRunning: boolean; hint: string | null }
  | { type: "delta"; text: string; full: string }
  | { type: "error"; message: string }
  | { type: "sidecar-missing"; expectedPath: string };

type Subscriber = (event: CaptionsEvent) => void;

const subscribers = new Set<Subscriber>();
let child: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopped = false;

function sidecarPath(): string {
  const isDev = !app.isPackaged;
  if (isDev) {
    return resolve(__dirname, "..", "..", "resources", "bin", "BrandonCaptions.exe");
  }
  return resolve(process.resourcesPath, "bin", "BrandonCaptions.exe");
}

function emit(event: CaptionsEvent): void {
  dbg(`emit ${event.type} subs=${subscribers.size} ${event.type === "delta" ? `text=${(event as { text: string }).text.slice(0, 60)}` : JSON.stringify(event).slice(0, 200)}`);
  for (const sub of subscribers) {
    try { sub(event); } catch (err) { dbg(`sub error: ${(err as Error).message}`); }
  }
}

function start(): void {
  const exe = sidecarPath();
  dbg(`start() exe=${exe} exists=${existsSync(exe)}`);
  if (!existsSync(exe)) {
    emit({ type: "sidecar-missing", expectedPath: exe });
    return;
  }
  let proc: ChildProcess;
  try {
    proc = spawn(exe, [], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    dbg(`spawned pid=${proc.pid}`);
  } catch (err) {
    dbg(`spawn error: ${(err as Error).message}`);
    emit({ type: "error", message: `Failed to spawn captions sidecar: ${(err as Error).message}` });
    return;
  }
  child = proc;

  let buffer = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    dbg(`stdout chunk len=${chunk.length}`);
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as CaptionsEvent;
        emit(event);
      } catch {
        dbg(`bad JSON: ${line.slice(0, 200)}`);
        emit({ type: "error", message: `Bad JSON from sidecar: ${line.slice(0, 200)}` });
      }
    }
  });

  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (chunk: string) => {
    emit({ type: "error", message: `sidecar stderr: ${chunk.trim().slice(0, 500)}` });
  });

  proc.on("exit", (code) => {
    child = null;
    if (stopped) return;
    emit({ type: "error", message: `Captions sidecar exited (code=${code}); restarting in 2s` });
    restartTimer = setTimeout(start, 2000);
  });
}

export function startCaptionsSidecar(): void {
  if (child) return;
  stopped = false;
  start();
}

export function stopCaptionsSidecar(): void {
  stopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    try { child.kill(); } catch { /* noop */ }
    child = null;
  }
}

export function onCaptionsEvent(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  dbg(`subscribed; total subs=${subscribers.size}`);
  return () => { subscribers.delete(subscriber); dbg(`unsubscribed; total subs=${subscribers.size}`); };
}

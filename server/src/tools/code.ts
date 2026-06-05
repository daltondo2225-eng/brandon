import { promises as fs } from "node:fs";
import { resolve, sep, basename, dirname } from "node:path";

/**
 * Code-access tools exposed to the model when `profile.repoRoot` is set.
 * Both tools are scoped to a single root directory and reject any path that
 * resolves outside it. No symlink follow, no binary read.
 *
 * Designed for "explain this code" / present-and-defend interviews — the
 * model picks files to read on demand and cites `path:line` in its response.
 */

/** Hard caps on what the model can pull back in one call. */
const MAX_FILE_BYTES = 30 * 1024;     // ~30 KB per read
const MAX_LINES_PER_READ = 200;       // even on a small file, 200 lines max
const MAX_DIR_ENTRIES = 200;          // listDir caps at 200 names

/** Directories never listed/entered — skip these names anywhere in the tree. */
const SKIP_DIRS = new Set([
  "node_modules", "bin", "obj", ".git", ".vs", ".vscode",
  "dist", "build", "out", "release", "win-unpacked",
  ".next", ".nuxt", ".cache", ".turbo",
]);

export interface ReadFileResult {
  /** Relative path returned (echoed back so the model has the exact string). */
  path: string;
  /** File content with one-based line-number prefix, e.g. `   42 │ public class …`. */
  content: string;
  /** Range that was actually read — handy for the SSE tool event. */
  startLine: number;
  endLine: number;
  totalLines: number;
  /** True if there are more lines past `endLine` not included in this read. */
  truncated: boolean;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
  /** File size in bytes. Omitted for directories. */
  size?: number;
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

/**
 * Resolve `relPath` against `repoRoot` and confirm it stays inside.
 * Returns the absolute path (with no symlink follow). Throws if outside.
 */
function safeResolve(repoRoot: string, relPath: string): string {
  const root = resolve(repoRoot);
  // An empty string / "." / "./" means "the root itself".
  const cleaned = relPath.replace(/^\/+/, "").trim();
  const abs = cleaned ? resolve(root, cleaned) : root;
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path outside repoRoot: ${relPath}`);
  }
  // Any segment in the skip list = refuse (we don't want the model trying to
  // read inside node_modules or bin/obj even if the path technically resolves).
  const rel = abs.slice(root.length).replace(/^[\\/]/, "");
  if (rel) {
    for (const part of rel.split(/[\\/]/)) {
      if (SKIP_DIRS.has(part)) {
        throw new Error(`refusing to access ${part}/ — out of scope`);
      }
    }
  }
  return abs;
}

/**
 * Read a slice of a text file. Default behaviour: full file up to MAX_LINES.
 * For larger files, supply `startLine` + `endLine` (1-based, inclusive).
 *
 * Output text is prefixed with line numbers so the model emits accurate
 * `path:line` citations in its response (no off-by-one risk).
 */
export async function readFile(
  repoRoot: string,
  relPath: string,
  opts: { startLine?: number; endLine?: number } = {},
): Promise<ReadFileResult> {
  if (!relPath || relPath.trim() === "") {
    throw new Error("path is required");
  }
  const abs = safeResolve(repoRoot, relPath);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    throw new Error(`${relPath} is a directory — use list_dir`);
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`${relPath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large`);
  }
  const buf = await fs.readFile(abs);
  // Reject obviously binary files (a NUL byte in the first 8 KB is a strong signal).
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  if (sniff.includes(0)) {
    throw new Error(`${relPath} looks binary — refusing to read`);
  }
  const text = buf.toString("utf8");
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;

  const start = Math.max(1, opts.startLine ?? 1);
  const requestedEnd = opts.endLine ?? totalLines;
  let end = Math.min(totalLines, Math.max(start, requestedEnd));
  // Enforce the per-read line cap.
  if (end - start + 1 > MAX_LINES_PER_READ) {
    end = start + MAX_LINES_PER_READ - 1;
  }

  // Build numbered output, trimming if we exceed the byte cap.
  const out: string[] = [];
  let bytes = 0;
  const numWidth = String(end).length;
  let truncated = end < totalLines;
  for (let i = start; i <= end; i++) {
    const line = `${String(i).padStart(numWidth, " ")} │ ${allLines[i - 1] ?? ""}`;
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_FILE_BYTES) {
      truncated = true;
      end = i - 1;
      break;
    }
    out.push(line);
  }

  // Normalise the echoed path to forward slashes — better for the model.
  const echoedPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return {
    path: echoedPath,
    content: out.join("\n"),
    startLine: start,
    endLine: end,
    totalLines,
    truncated,
  };
}

/**
 * List the immediate children of a directory (one level deep). Filters out
 * the SKIP_DIRS names. Sorts directories first, then files, both alphabetically.
 */
export async function listDir(repoRoot: string, relPath = ""): Promise<ListDirResult> {
  const abs = safeResolve(repoRoot, relPath);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`${relPath} is a file — use read_file`);
  }
  const names = await fs.readdir(abs);
  const entries: DirEntry[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    if (entries.length >= MAX_DIR_ENTRIES) break;
    const childAbs = resolve(abs, name);
    try {
      const childStat = await fs.lstat(childAbs);
      if (childStat.isSymbolicLink()) continue; // no symlink follow
      if (childStat.isDirectory()) entries.push({ name, type: "dir" });
      else if (childStat.isFile()) entries.push({ name, type: "file", size: childStat.size });
      // skip everything else (sockets, fifos, etc.)
    } catch { /* unreadable child — skip */ }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const echoedPath = (relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return {
    path: echoedPath,
    entries,
    truncated: names.length > MAX_DIR_ENTRIES,
  };
}

/** Tool JSON Schemas for Anthropic's tool-use API. */
export const CODE_TOOL_DEFS = [
  {
    name: "read_file",
    description:
      "Read a text file inside the candidate's project. Returns the content with " +
      "line numbers prefixed so you can cite `path:line` accurately. Use this BEFORE " +
      "answering any code-specific question — do not rely on memory. For large files, " +
      "pass `startLine` and `endLine` to read just the relevant slice.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root, e.g. 'backend/TodoApi/Endpoints/TodoEndpoints.cs'. Use forward slashes.",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-based start line. Default 1.",
        },
        endLine: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-based end line (inclusive). Default end-of-file, capped at 200 lines per call.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description:
      "List the immediate contents of a directory in the candidate's project. Returns " +
      "files and subfolders one level deep. Useful for orienting yourself before calling " +
      "read_file. Empty `path` lists the repository root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root. Empty string or '.' for the root.",
        },
      },
      required: [],
    },
  },
] as const;

/** Run a tool by name. The agentic loop in claude/client.ts calls this. */
export async function runCodeTool(
  toolName: string,
  input: unknown,
  repoRoot: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const args = (input ?? {}) as Record<string, unknown>;
    if (toolName === "read_file") {
      const path = typeof args.path === "string" ? args.path : "";
      const startLine = typeof args.startLine === "number" ? args.startLine : undefined;
      const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
      return { ok: true, result: await readFile(repoRoot, path, { startLine, endLine }) };
    }
    if (toolName === "list_dir") {
      const path = typeof args.path === "string" ? args.path : "";
      return { ok: true, result: await listDir(repoRoot, path) };
    }
    return { ok: false, error: `unknown tool: ${toolName}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Re-export helpers for callers that just want the names.
export const CODE_TOOL_NAMES = CODE_TOOL_DEFS.map((d) => d.name);
// silence unused import warnings if any future helper drops the imports
void basename; void dirname;

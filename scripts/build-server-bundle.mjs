#!/usr/bin/env node
// Bundle the Brandon server into a single server.mjs (deps inlined) plus its
// schema.sql, and — when --with-node is passed — copy the current node runtime
// alongside it. The desktop app then runs `node(.exe) server.mjs`, so the
// target machine needs NO separately-installed Node.
//
// This replaces the earlier Node SEA approach, which is unreliable on recent
// Node versions (the SEA fuse sentinel is absent from distributed binaries, so
// postject injection fails). Bundling the runtime is boring and dead-reliable.
//
// Output (default out = client-tauri/src-tauri/bin):
//   server.mjs            (esbuild bundle, all JS deps inlined)
//   schema.sql            (read at runtime, sits next to server.mjs)
//   node.exe / node       (only with --with-node)
//
// Usage:
//   node scripts/build-server-bundle.mjs [--out=<dir>] [--with-node]

import esbuild from "esbuild";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER_SRC = resolve(ROOT, "server");
const IS_WIN = process.platform === "win32";

const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT = outArg
  ? resolve(ROOT, outArg.slice("--out=".length))
  : resolve(ROOT, "client-tauri", "src-tauri", "bin");
const WITH_NODE = process.argv.includes("--with-node");

function step(msg) { console.log(`\n=== ${msg} ===`); }

mkdirSync(OUT, { recursive: true });

// 1. Bundle the server into one ESM file (top-level await + import.meta need ESM).
step("esbuild bundle → server.mjs");
await esbuild.build({
  entryPoints: [resolve(SERVER_SRC, "src", "index.ts")],
  outfile: resolve(OUT, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle", // inline all node_modules deps
  external: ["node:*"],
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
  legalComments: "none",
});

// 2. schema.sql sits next to server.mjs (the server's readSchema() filesystem
//    fallback finds it relative to the bundle dir).
step("copy schema.sql");
copyFileSync(
  resolve(SERVER_SRC, "src", "db", "schema.sql"),
  resolve(OUT, "schema.sql"),
);

// 3. Optionally bundle the node runtime so the target needs no installed Node.
if (WITH_NODE) {
  step("copy node runtime");
  // Guard: a self-contained Node binary is tens of MB. A tiny one (e.g.
  // Homebrew's macOS launcher, ~68KB) dynamically links libnode and would be
  // broken once copied away from its lib dir. Fail loudly rather than ship a
  // runtime that can't start. (The official Node distribution used by
  // actions/setup-node on the CI runner is self-contained, so CI is fine.)
  const srcSize = statSync(process.execPath).size;
  if (srcSize < 20_000_000) {
    throw new Error(
      `Refusing to bundle node: ${process.execPath} is only ${(srcSize / 1024 / 1024).toFixed(1)} MB, ` +
      "which means it's dynamically linked (e.g. Homebrew). Use an official self-contained " +
      "Node build (nodejs.org / actions/setup-node) so the bundled runtime actually runs.",
    );
  }
  const dest = resolve(OUT, IS_WIN ? "node.exe" : "node");
  copyFileSync(process.execPath, dest);
  console.log(`Bundled node runtime (${(srcSize / 1024 / 1024).toFixed(0)} MB) → ${dest}`);
} else {
  console.log("(skipped node runtime — pass --with-node to bundle it)");
}

step("done");
console.log(`Staged server bundle at ${OUT}`);

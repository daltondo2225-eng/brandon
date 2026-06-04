#!/usr/bin/env node
// Build the Brandon server as a standalone Single Executable Application (SEA)
// so the desktop app can ship a server binary that needs NO Node on the target
// machine. This is the key Windows fix: end users won't have node on PATH.
//
// SEA uses the EXACT node binary you run this script with, so:
//   - run it on Windows  -> produces brandon-server.exe (ship this in the .msi)
//   - run it on macOS    -> produces brandon-server      (for local dev testing)
// You cannot cross-build; build on the OS you're packaging for.
//
// Requires Node >= 22.5 (we rely on node:sqlite, stable there). SEA itself is
// stable enough for our single-server use. References:
//   https://nodejs.org/api/single-executable-applications.html
//
// Output:
//   <out>/brandon-server[.exe]   (default out = client-tauri/src-tauri/bin)
//
// Usage:
//   node scripts/build-server-sea.mjs [--out=<dir>]

import esbuild from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER_SRC = resolve(ROOT, "server");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? "brandon-server.exe" : "brandon-server";

const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT = outArg
  ? resolve(ROOT, outArg.slice("--out=".length))
  : resolve(ROOT, "client-tauri", "src-tauri", "bin");

function step(msg) { console.log(`\n=== ${msg} ===`); }

// ---- Node version guard (node:sqlite needs >= 22.5) -------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Node ${process.versions.node} is too old; need >= 22.5 for node:sqlite SEA.`);
  process.exit(1);
}

const stage = mkdtempSync(resolve(tmpdir(), "brandon-sea-"));
try {
  // ---- 1. Bundle everything into ONE CommonJS file --------------------------
  // SEA needs a single CJS entry. Unlike the Electron packaging (which kept
  // deps external and npm-installed them), here we inline ALL JS deps so the
  // blob is self-contained. node: builtins stay external (provided by the
  // embedded runtime). pdf-parse/mammoth are CJS and bundle cleanly via their
  // inner entry points (see server/src/ingest/pdf.ts).
  // ESM output: the server source uses top-level await (route registration) and
  // import.meta, both of which require ESM. Node SEA accepts an ESM main on
  // Node >= 21. We add a createRequire shim so any CJS-style require() inside
  // bundled deps (mammoth/pdf-parse) and our own require("node:sea") resolve.
  step("esbuild bundle → single ESM");
  const bundlePath = resolve(stage, "server.mjs");
  await esbuild.build({
    entryPoints: [resolve(SERVER_SRC, "src", "index.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Inline everything in node_modules; keep only Node builtins external.
    packages: "bundle",
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

  // schema.sql is embedded INTO the blob as an asset (read at runtime via
  // node:sea getAsset — see server/src/db/client.ts). In an SEA binary there is
  // no real file next to the exe, so embedding is the reliable way.
  step("stage schema.sql for blob embedding");
  const schemaStage = resolve(stage, "schema.sql");
  copyFileSync(resolve(SERVER_SRC, "src", "db", "schema.sql"), schemaStage);

  // ---- 2. Generate the SEA blob ---------------------------------------------
  step("generate SEA blob");
  const seaConfig = {
    main: bundlePath,
    output: resolve(stage, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    assets: {
      "schema.sql": schemaStage,
    },
    // useSnapshot/useCodeCache left off — they complicate native addons and our
    // startup is fast enough without them.
  };
  const seaConfigPath = resolve(stage, "sea-config.json");
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit",
  });

  // ---- 3. Copy the node binary and inject the blob --------------------------
  step("copy node runtime → target executable");
  mkdirSync(OUT, { recursive: true });
  const outExe = resolve(OUT, EXE);
  copyFileSync(process.execPath, outExe);
  // node ships read-only (mode 0555); postject must open it for writing.
  chmodSync(outExe, 0o755);

  // Sanity-check the copy size. Homebrew's macOS node is a tiny (~68KB)
  // dynamically-linked launcher that CANNOT be turned into a working SEA — warn
  // loudly so a dev doesn't ship a broken mac binary. Windows node.exe is a
  // proper self-contained binary (tens of MB) and works fine.
  const copiedSize = statSync(outExe).size;
  if (copiedSize < 5_000_000) {
    console.warn(
      `\n⚠️  Copied node runtime is only ${(copiedSize / 1024).toFixed(0)} KB — ` +
        "this looks like a dynamically-linked launcher (common with Homebrew node on macOS).\n" +
        "   SEA injection needs a self-contained node binary. On Windows this is fine.\n" +
        "   For a working macOS test, use the official Node.js installer build, not Homebrew.\n"
    );
  }

  // macOS: remove the signature before injecting, re-sign after (ad-hoc).
  if (process.platform === "darwin") {
    try { execSync(`codesign --remove-signature "${outExe}"`); } catch { /* ok */ }
  }

  step("inject blob with postject");
  // postject is run via npx so we don't add a hard dependency; it's tiny.
  const sentinel = "NODE_SEA_FUSE_fce680ab2cc2b1023f4b8e5b03d8 b5f9".replace(/\s/g, "");
  const postjectArgs = [
    "postject", outExe, "NODE_SEA_BLOB", resolve(stage, "sea-prep.blob"),
    "--sentinel-fuse", sentinel,
  ];
  if (process.platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  execSync(`npx --yes ${postjectArgs.join(" ")}`, { stdio: "inherit" });

  if (process.platform === "darwin") {
    try { execSync(`codesign --sign - "${outExe}"`); } catch { /* ok */ }
  }
  if (!IS_WIN) chmodSync(outExe, 0o755);

  step("done");
  console.log(`Built standalone server: ${outExe}`);
  console.log("schema.sql is embedded in the blob (read via node:sea getAsset).");
} finally {
  rmSync(stage, { recursive: true, force: true });
}

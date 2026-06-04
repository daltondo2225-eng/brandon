#!/usr/bin/env node
// Stage the Brandon server into client/resources/server/ for electron-builder.
//
// Strategy: esbuild bundles the server into a single ESM file with
// @brandon/shared inlined; all node_modules runtime deps stay external
// (fastify, anthropic SDK, pdf-parse, mammoth, dotenv) and are installed by
// running `npm install --omit=dev` against a minimal package.json.
//
// Layout produced:
//   client/resources/server/
//     package.json           (production deps only)
//     dist/index.mjs         (bundled server)
//     dist/db/schema.sql     (read at startup by the bundled code)
//     node_modules/          (production install)

import esbuild from "esbuild";
import { execSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER_SRC = resolve(ROOT, "server");
// Default stage dir is the Electron resources path; override with --out=<dir>
// (or BRANDON_SERVER_STAGE) so the Tauri build can stage into src-tauri/server.
const outArg = process.argv.find((a) => a.startsWith("--out="));
const STAGE = outArg
  ? resolve(ROOT, outArg.slice("--out=".length))
  : process.env.BRANDON_SERVER_STAGE
    ? resolve(ROOT, process.env.BRANDON_SERVER_STAGE)
    : resolve(ROOT, "client", "resources", "server");

function step(msg) { console.log(`\n=== ${msg} ===`); }
function run(cmd, cwd) {
  console.log(`> ${cmd}  (cwd=${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

const serverPkg = JSON.parse(readFileSync(resolve(SERVER_SRC, "package.json"), "utf8"));
const allDeps = Object.keys(serverPkg.dependencies ?? {});
// @brandon/shared is a workspace package whose runtime values are only type
// constants — we inline it via esbuild so the staged server doesn't depend on
// the workspace layout.
const EXTERNAL = allDeps.filter((d) => d !== "@brandon/shared");

step("clean stage dir");
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(resolve(STAGE, "dist", "db"), { recursive: true });

step("esbuild bundle (externals: " + EXTERNAL.join(", ") + ")");
await esbuild.build({
  entryPoints: [resolve(SERVER_SRC, "src", "index.ts")],
  outfile: resolve(STAGE, "dist", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL,
  // ESM-CJS interop: some externals (mammoth, pdf-parse) are CJS. esbuild's
  // default ESM output uses `import` which fails for CJS named imports. Banner
  // shims createRequire so the few `require(...)` calls inside externals work.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

step("copy schema.sql");
// esbuild emits dist/index.mjs whose __dirname resolves to dist/, so schema.sql
// must live there too. Also copy to dist/db/ to support the dev layout.
cpSync(
  resolve(SERVER_SRC, "src", "db", "schema.sql"),
  resolve(STAGE, "dist", "schema.sql"),
);
cpSync(
  resolve(SERVER_SRC, "src", "db", "schema.sql"),
  resolve(STAGE, "dist", "db", "schema.sql"),
);

step("write production package.json");
const stagedPkg = {
  name: "brandon-server-bundle",
  version: serverPkg.version,
  private: true,
  type: "module",
  main: "dist/index.mjs",
  dependencies: Object.fromEntries(
    EXTERNAL.map((d) => [d, serverPkg.dependencies[d]]),
  ),
};
writeFileSync(resolve(STAGE, "package.json"), JSON.stringify(stagedPkg, null, 2));

step("npm install --omit=dev (production deps only)");
run("npm install --omit=dev --no-audit --no-fund --ignore-scripts", STAGE);

step("done");
console.log(`Staged server at ${STAGE}`);

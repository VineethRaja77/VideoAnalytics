// scripts/build-protected.mjs
//
// Produces the IP-protected server build for shipping to on-prem clients:
//   1. vite build            -> dist/public (frontend; inherently client-side)
//   2. esbuild (CJS bundle)  -> dist/server.cjs  (all OUR server code, one file)
//   3. bytenode compile      -> dist/server.jsc  (V8 bytecode — not readable)
//   4. delete dist/server.cjs (remove the readable source)
//   5. write dist/index.cjs  (tiny launcher: loads bytenode + the .jsc)
//
// The .jsc is tied to the V8/Node major version it was compiled with, so
// on-prem installs must run the same Node major (documented in deploy/README).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bytenode from "bytenode";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const cjs = path.join(dist, "server.cjs");
const jsc = path.join(dist, "server.jsc");
const launcher = path.join(dist, "index.cjs");

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

console.log("→ [1/5] Building frontend (vite)…");
run("npx vite build");

console.log("→ [2/5] Bundling server to CommonJS (esbuild)…");
run(
  [
    "npx esbuild server/index.ts",
    "--platform=node",
    "--packages=external",
    "--bundle",
    "--format=cjs",
    "--target=node22",
    "--define:import.meta.dirname=__dirname",
    // Dev-only Vite integration is never used in production; keep it out of the
    // bundle so its top-level await doesn't break the CJS/bytecode build.
    "--external:./vite",
    `--outfile=${cjs}`,
  ].join(" ")
);

console.log("→ [3/5] Compiling to V8 bytecode (bytenode)…");
await bytenode.compileFile({ filename: cjs, output: jsc });

console.log("→ [4/5] Removing readable server source…");
fs.rmSync(cjs, { force: true });

console.log("→ [5/5] Writing launcher dist/index.cjs…");
fs.writeFileSync(
  launcher,
  [
    "// Protected launcher — loads the V8-bytecode server bundle.",
    "require('bytenode');",
    "require('./server.jsc');",
    "",
  ].join("\n")
);

console.log("✅ Protected build complete:");
console.log("   dist/server.jsc  (bytecode, no readable source)");
console.log("   dist/index.cjs   (launcher)  ->  run with: node dist/index.cjs");

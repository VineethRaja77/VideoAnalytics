// server/serve.ts
//
// Production static-file serving + the shared log() helper. Kept free of any
// Vite imports so the production bundle never pulls in the dev toolchain
// (which uses top-level await and can't be compiled to CommonJS/bytecode).
// The Vite dev integration lives in ./vite and is imported dynamically, only
// in development.

import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

export function serveStatic(app: Express) {
  // import.meta.dirname resolves to the bundle's own directory (dist/); in the
  // bytecode build esbuild maps it to __dirname. Either way this points at
  // dist/public next to the running server bundle.
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

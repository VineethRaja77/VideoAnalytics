# Protected (bytecode) build — shipping to on-prem clients

The server is compiled to **V8 bytecode** so clients can't read the source or
the licensing/business logic. The frontend is inherently client-side JS and is
not (cannot be) bytecode — the protected IP is entirely server-side.

## Build
```bash
npm run build:protected
```
Produces in `dist/`:
- `server.jsc`  — the entire server as V8 bytecode (no readable source)
- `index.cjs`   — tiny launcher (`require('bytenode'); require('./server.jsc')`)
- `public/`     — the frontend (normal browser assets)

`dist/server.cjs` (the readable bundle) is generated then **deleted** by the build.

## Run
```bash
npm run start:protected        # NODE_ENV=production node dist/index.cjs
```
The installed systemd unit (`deploy/vms-app.service`) already runs `dist/index.cjs`.

## What to ship to an on-prem client (and what NOT to)
SHIP:   dist/ (index.cjs, server.jsc, public/), node_modules/, package.json, drizzle/ migrations, and the client's signed `license.lic` + `/etc/vms/mediamtx.yml`.
DO NOT SHIP: server/ or client/ source, dist/index.js, shared/ *.ts — none are needed at runtime (proven: the service runs with all source removed).

## IMPORTANT — Node version
V8 bytecode is tied to the V8 major version it was compiled with. This build
was compiled with **Node v22**. On-prem installs MUST run the same Node major
(v22.x). Recompile (`npm run build:protected`) on/for the target's Node major
if it differs.

## Two-layer protection (recap)
1. Bytecode: the logic isn't readable/editable on the client's disk.
2. Licensing (Phase 2): even the bytecode won't enable a module without a valid,
   machine-locked, unexpired signed license + successful phone-home.

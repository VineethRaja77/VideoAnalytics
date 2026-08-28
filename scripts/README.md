# `scripts/` — operational tooling

[← back to the root README](../README.md) · siblings: [deploy/](../deploy/README.md) · [server/](../server/README.md) · [models/](../models/README.md)

Seven scripts. Each exists because something failed silently once.

| Script | Run it when |
|---|---|
| [`install-models.sh`](install-models.sh) | before any AI feature can work, on every install |
| [`build-protected.mjs`](build-protected.mjs) | building a release for an on-prem client |
| [`backup.sh`](backup.sh) | nightly, from cron |
| [`restore.sh`](restore.sh) | disaster — and once, as a drill, **before** you need it |
| [`e2e-camera.sh`](e2e-camera.sh) | proving a build actually records video |
| [`simulate-sensors.ts`](simulate-sensors.ts) | developing anything sensor-related, with no hardware |
| [`audit_dataset.py`](audit_dataset.py) | before spending GPU hours on a merged dataset |

---

## `install-models.sh` — build the per-module Python environments

```bash
./scripts/install-models.sh              # all modules
./scripts/install-models.sh ppe vehicle  # only these
PYTHON=python3.12 ./scripts/install-models.sh
```

[`analyticsWorker.ts`](../server/analyticsWorker.ts) launches each module with
its **own** interpreter, `models/<module>/.venv/bin/python`. On a machine where
the venv was never built, the old fallback to system `python3` was silent and
fatal: the worker died on `import dotenv` before printing anything useful, the
supervisor counted it as a crash, and it restart-looped forever. The analytic
simply never produced events and nothing said why. This was found on the
development box itself — four of six modules had no venv and could never have
started.

For every module with a `requirements.txt` it creates `.venv`, installs pinned
dependencies, then **import-checks the worker**. An install that "succeeds" but
cannot import is the failure mode that matters, so it is verified rather than
assumed. Safe to re-run.

Separate environments per module are deliberate: a site that licensed only
vehicle counting should not carry PPE's dependency tree (historically including
`torch`, ~5.8 GB) on disk.

**Weights are not installed by this script** — copy them into
`models/<module>/weights/`, then pin their checksums with
`npx tsx server/modelRegistry.ts --record`.

---

## `build-protected.mjs` — the on-prem release build

```bash
npm run build:protected
```

```
1. vite build           → dist/public          (frontend; inherently client-side)
2. esbuild → CJS        → dist/server.cjs      (all our server code, one file)
3. bytenode compile     → dist/server.jsc      (V8 bytecode — not readable)
4. delete dist/server.cjs                      (remove the readable source)
5. write dist/index.cjs                        (tiny launcher: bytenode + .jsc)
```

**The `.jsc` is tied to the V8/Node major version it was compiled with**, so an
on-prem install must run the same Node major. This is also why
[`server/vite.ts`](../server/vite.ts) is imported dynamically and
[`server/serve.ts`](../server/serve.ts) is Vite-free: the dev integration uses
top-level await and cannot be compiled to CommonJS.

Details: [deploy/PROTECTED-BUILD.md](../deploy/PROTECTED-BUILD.md).

---

## `backup.sh` / `restore.sh`

```bash
./scripts/backup.sh                       # uses .env, writes to ./backups
BACKUP_DIR=/mnt/nas/vms ./scripts/backup.sh
# cron:  15 2 * * *  /opt/vms/scripts/backup.sh >> /var/log/vms/backup.log 2>&1
```

**Backed up:** the Postgres database — users, orgs, licences, cameras, analytics
events, the recording index, and the audit trail. Plus the `.env` encryption
keys, *separately* and only if `BACKUP_INCLUDE_KEYS=true`.

**Not backed up, on purpose:** video recordings. On a real site these are
hundreds of GB to tens of TB and change constantly; copying them nightly would
fill the backup target faster than the primary disk. Retention is a storage-array
decision (RAID / NAS / separate volume), not a `pg_dump` decision. The
`recordings` *table* is backed up, so after a restore the system knows which
files it expects and reports the missing ones instead of silently showing an
empty timeline.

> **The key warning.** Camera credentials are encrypted with
> `SECRET_ENCRYPTION_KEY`. A database backup **without** that key restores to a
> system where every camera fails to connect and the reason is invisible. Store
> the key separately from the dump — together in one place and the encryption
> bought you nothing.

```bash
./scripts/restore.sh backups/vms-db-20260816-021500.dump
TARGET_DATABASE_URL=postgres://…/vms_restore_test ./scripts/restore.sh <dump>
```

A backup nobody has ever restored is not a backup. `restore.sh` refuses to
overwrite the database named in `.env` without `--force`, because the common
disaster is restoring last week's dump over a working production database by
muscle memory.

---

## `e2e-camera.sh` — the only test that proves the product

```bash
./scripts/e2e-camera.sh    # against an already-running server
```

Everything in [`server/__tests__/`](../server/__tests__/) is unit or integration
level. None of it proves the thing a client actually buys: point the system at a
camera and get recorded video back. This publishes a synthetic H.264 stream into
MediaMTX with GStreamer and drives the platform's own HTTP API against it.

**Proven:** camera creation through the API → MediaMTX reports the path ready →
the recorder starts and writes real `.mp4` segments → segments are indexed in
`recordings` with a real duration → a segment is a valid, decodable MP4 →
deleting the camera stops the recorder and cleans up.

**Not proven:** vendor RTSP dialects, H.265 streams, auth negotiation, network
flap, clock drift. A synthetic source is well behaved by definition. This is a
regression guard, not a substitute for one real camera on site.

---

## `simulate-sensors.ts` — a fake building

```bash
npx tsx scripts/simulate-sensors.ts --provision   # create devices + rules
npx tsx scripts/simulate-sensors.ts               # publish telemetry
```

Exercises the whole sensor pipeline with no hardware: provisioning, ingest,
thresholds, debounce, staleness, calibration, parking counts, alerts. It models
the four scenarios that matter commercially, each chosen to hit a *failure* path
rather than a happy one:

1. **Parking** — 20 bays filling and emptying, plus one sensor that **dies
   mid-run**; the free count must drop it to `unknown`, never count it vacant.
2. **Water tank** — a slow drain through the low-level threshold.
3. **pH probe** — drifts out of the 6.5–8.5 band, and one probe is past its
   calibration date, so its readings must be marked `suspect` and must **not**
   raise alerts.
4. **Diesel** — normal generator consumption, then a sharp overnight drop while
   the DG is off: the theft signature.

---

## `audit_dataset.py` — look at the data before spending the GPU hours

```bash
python scripts/audit_dataset.py <coco_dataset_dir>
```

The fire model wasted ~9.5 hours of training to reach mAP50 0.574. The cause was
visible in the data and nobody looked: one source contributed ~89% of the images
and was **pre-augmented** (15,345 files from ~6,391 originals), so the model
largely learned that source's augmentation. Licence and image *count* had been
verified from the Roboflow API; data *quality* had not.

It checks:

1. **Duplicate / near-duplicate images** by perceptual hash — a high rate means
   the source is pre-augmented, and a big pre-augmented source drowns the others.
2. **Source balance** — one dataset dominating a merge.
3. **Box size distribution** — objects under ~2% of image area are hard at any
   resolution and drag mAP down regardless of training length.

Run it on every merged dataset and read the verdict **before** starting a run.
See [train/](../train/README.md) for the pipelines that produce those datasets.

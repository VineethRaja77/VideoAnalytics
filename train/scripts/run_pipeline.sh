#!/bin/bash
# Full rebuild driver: fetch ~14k public -> append ~6k BIDJOE (gloves negatives)
# -> merge with 331 auto-labeled site frames -> train -> test. Logs to train/.
set -u
cd "$(dirname "$0")"
source ../../models/ppe/.venv/bin/activate
LOG=../pipeline.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "REBUILD started"

say "fetching ~14k public (hiennguyen+hardhat+francesco)..."
python3 -u fetch_public.py > ../fetch_public.log 2>&1
say "public fetch done: $(ls ../public_labeled/*.jpg 2>/dev/null | wc -l) images"

say "appending BIDJOE gloves/negatives..."
python3 -u build_bidjoe.py > ../bidjoe.log 2>&1
say "bidjoe appended: total public now $(ls ../public_labeled/*.jpg 2>/dev/null | wc -l)"

say "merging + splitting..."
python3 -u merge_split.py > ../merge.log 2>&1
say "merge done: train=$(ls ../dataset/images/train/*.jpg 2>/dev/null | wc -l) val=$(ls ../dataset/images/val/*.jpg 2>/dev/null | wc -l)"

say "TRAINING started (CPU, ~20k imgs — long stage, checkpointed)..."
python3 -u train.py > ../train.log 2>&1
say "TRAINING finished"

if [ -f ../locked/ppe_person_best.pt ]; then
  say "testing locked model on a 1-min clip..."
  python3 -u test_locked.py > ../test_locked.log 2>&1
  say "test done -> outputs/trained_model_test.mp4"
else
  say "WARNING: no locked model produced"
fi

touch ../pipeline_done.flag
say "PIPELINE COMPLETE"

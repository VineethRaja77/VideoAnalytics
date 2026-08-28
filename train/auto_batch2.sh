#!/bin/bash
cd "$(dirname "$0")"
source ../models/ppe/.venv/bin/activate
until grep -q "ALL DONE" prep_cvat.log 2>/dev/null; do sleep 60; done
sleep 20
python3 -u make_task.py "PPE Site - Batch 2" > make_task_b2.log 2>&1
# import pre-annotations for batch 2 (frames in manifest not already imported handled by make_task snapshot)
echo "batch2 task created" >> make_task_b2.log

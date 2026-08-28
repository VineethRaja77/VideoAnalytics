"""Create a CVAT task under the PPE project from a snapshot of ready frames.
Records which frames were used so the next batch excludes them."""
import os, glob, sys, json
from cvat_sdk import make_client
from cvat_sdk.core.proxies.tasks import ResourceType

HOST="https://label.hyperspark.in"
USER,PW="admin","htlIeq6b7aUPI/L3"
FRAMES="/home/hyperspark/VMS/VMS/VMS_PRODUCTION/train/site_cvat/obj_train_data"
USED_MANIFEST="/home/hyperspark/VMS/VMS/VMS_PRODUCTION/train/cvat_used_frames.json"
PROJECT_ID=1
BATCH_NAME=sys.argv[1] if len(sys.argv)>1 else "PPE Site - Batch 1"

used=set()
if os.path.exists(USED_MANIFEST):
    used=set(json.load(open(USED_MANIFEST)))

allimgs=sorted(glob.glob(f"{FRAMES}/*.jpg"))
new=[p for p in allimgs if p not in used]
if not new:
    print("no new frames to add"); sys.exit(0)
print(f"creating task '{BATCH_NAME}' with {len(new)} frames (jobs of 100)")

with make_client(host=HOST, credentials=(USER,PW)) as client:
    task = client.tasks.create_from_data(
        spec={"name":BATCH_NAME,"project_id":PROJECT_ID,"segment_size":100},
        resource_type=ResourceType.LOCAL,
        resources=new,
    )
    print("TASK created id:", task.id, "size:", task.size)

used.update(new)
json.dump(sorted(used), open(USED_MANIFEST,"w"))
print(f"manifest updated: {len(used)} frames now assigned to tasks")

from huggingface_hub import hf_hub_download
import shutil, os
p = hf_hub_download(repo_id="BIDJOE/ppe-14classes",
                    filename="dataset_bidjoe_14classes.zip",
                    repo_type="dataset")
os.makedirs("public_raw", exist_ok=True)
dst = "public_raw/bidjoe14.zip"
if os.path.abspath(p) != os.path.abspath(dst):
    shutil.copy(p, dst)
print("DOWNLOADED ->", dst, os.path.getsize(dst), "bytes")

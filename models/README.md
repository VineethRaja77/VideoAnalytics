# Analytics models

AI analytics modules (PPE, FRS, ANPR, fire, fall, …) live here. Each is a
**standalone Python worker**, independent of the Node platform, because
computer-vision inference is a Python/PyTorch world (YOLO, OpenCV).

## How a model plugs into the platform

Every model worker follows the same shape:

1. **Input** — reads a camera's stream from MediaMTX's re-published RTSP
   (`rtsp://127.0.0.1:8554/cam_<id>`), NOT the physical camera directly. The
   camera is already pulled once by MediaMTX; the worker is just another local
   reader, so it adds zero load on the camera (same pattern as the recorder).
2. **Inference** — samples frames (a few per second, not 30fps) and runs the
   model.
3. **Rules** — turns raw detections into events (e.g. "person without hardhat").
4. **Output** — POSTs events to the Node platform, which stores them and shows
   alerts/notifications. Gated by the tenant's license for that module
   (`ppe`, `frs`, …) via the existing products/licenses tables.

One worker process handles one (or a few) cameras; scale by running more
workers, sharded across cameras/machines.

## Modules

- `ppe/` — Personal Protective Equipment detection (hardhat, vest, …).

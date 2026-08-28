import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Pencil, Trash2, Plus, Camera, Play, Square } from "lucide-react";

import { Camera as BaseCamera } from "./CameraCard";
import { apiRequest } from "@/lib/queryClient";
import { useAuth, canWrite } from "@/lib/auth";

// EXTENDED Camera for editing (only extra fields we added)
export interface EditableCamera
  extends Omit<BaseCamera, "streamUrl" | "streamType"> {
  streamUrl?: string;
  streamType?: string;

  port?: string;
  username?: string;
  password?: string;
  vendor?: string;
  streamMode?: "main" | "sub";

  isStreaming?: boolean;
}


interface CameraListProps {
  cameras: EditableCamera[];
  onUpdateCamera: (camera: EditableCamera) => void;
  onDeleteCamera: (id: string) => void;
  onAddCamera: () => void;
}

export default function CameraList({
  cameras,
  onUpdateCamera,
  onDeleteCamera,
  onAddCamera,
}: CameraListProps) {
  const auth = useAuth();
  const writable = canWrite(auth.role);
  const [editingCamera, setEditingCamera] = useState<EditableCamera | null>(null);

  // Optimistic overrides so Start/Stop feel instant; the next /api/cameras
  // poll (every 10s) reconciles with actual recorder/MediaMTX state.
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, boolean>>({});

  async function handleStart(cameraId: string) {
    try {
      await apiRequest("POST", "/api/streams/start", { cameraId });
      setPendingOverrides((prev) => ({ ...prev, [cameraId]: true }));
    } catch (err) {
      console.error("Error starting stream:", err);
    }
  }

  async function handleStop(cameraId: string) {
    try {
      await apiRequest("POST", "/api/streams/stop", { cameraId });
      setPendingOverrides((prev) => ({ ...prev, [cameraId]: false }));
    } catch (err) {
      console.error("Error stopping stream:", err);
    }
  }

  // Once the polled camera list agrees with an optimistic override, drop it.
  useEffect(() => {
    setPendingOverrides((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const cam of cameras) {
        if (cam.id in next && next[cam.id] === !!cam.isStreaming) {
          delete next[cam.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cameras]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Camera List</h2>
        <Button onClick={onAddCamera}>
          <Plus className="w-4 h-4 mr-2" />
          Add Camera
        </Button>
      </div>

      {cameras.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-96 border rounded-lg bg-card">
          <Camera className="h-16 w-16 text-muted-foreground mb-4" />
          <p className="text-lg font-semibold">No cameras available</p>
          <p className="text-sm text-muted-foreground mb-4">
            Add a new camera to begin
          </p>
          <Button onClick={onAddCamera}>Add Camera</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cameras.map((camera) => {
            const isRunning = pendingOverrides[camera.id] ?? !!camera.isStreaming;

            return (
              <Card key={camera.id}>
                <CardHeader>
                  <CardTitle className="flex justify-between">
                    {camera.name}
                    <span className="text-xs text-muted-foreground">
                      CH {camera.channelId}
                    </span>
                  </CardTitle>
                </CardHeader>

                <CardContent className="space-y-2 text-sm">
                  <div>
                    <Label className="text-muted-foreground">IP Address</Label>
                    <p>{camera.ipAddress || "N/A"}</p>
                  </div>

                  <div>
                    <Label className="text-muted-foreground">Username</Label>
                    <p>{camera.username || "N/A"}</p>
                  </div>

                  <div>
                    <Label className="text-muted-foreground">Stream Type</Label>
                    <p>{camera.streamType || "N/A"}</p>
                  </div>

                  {/* Write actions are hidden for read-only employees (server
                      also enforces this). */}
                  {writable && (
                    <div className="flex justify-between pt-3">
                      {/* Start/Stop Buttons */}
                      <div className="flex gap-2">
                        {!isRunning ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStart(camera.id);
                            }}
                          >
                            <Play className="w-4 h-4 mr-2" /> Start
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStop(camera.id);
                            }}
                          >
                            <Square className="w-4 h-4 mr-2" /> Stop
                          </Button>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingCamera(camera);
                          }}
                        >
                          <Pencil className="w-4 h-4 mr-2" /> Edit
                        </Button>

                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteCamera(camera.id);
                          }}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* EDIT CAMERA MODAL */}
      <Dialog open={!!editingCamera} onOpenChange={() => setEditingCamera(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Camera</DialogTitle>
          </DialogHeader>

          {editingCamera && (
            <>
              <div className="space-y-4">

                {/* Name */}
                <div className="flex flex-col gap-1">
                  <Label>Name</Label>
                  <Input
                    value={editingCamera.name}
                    onChange={(e) =>
                      setEditingCamera({ ...editingCamera, name: e.target.value })
                    }
                  />
                </div>

                {/* IP */}
                <div className="flex flex-col gap-1">
                  <Label>IP Address</Label>
                  <Input
                    value={editingCamera.ipAddress || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        ipAddress: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Port */}
                <div className="flex flex-col gap-1">
                  <Label>Port</Label>
                  <Input
                    value={editingCamera.port || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        port: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Vendor */}
                <div className="flex flex-col gap-1">
                  <Label>Vendor</Label>
                  <Input
                    value={editingCamera.vendor || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        vendor: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Stream Mode */}
                <div className="flex flex-col gap-1">
                  <Label>Stream Mode</Label>
                  <Input
                    value={editingCamera.streamMode || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        streamMode: e.target.value as "main" | "sub",
                      })
                    }
                  />
                </div>

                {/* Username */}
                <div className="flex flex-col gap-1">
                  <Label>Username</Label>
                  <Input
                    value={editingCamera.username || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        username: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Password */}
                <div className="flex flex-col gap-1">
                  <Label>Password</Label>
                  <Input
                    type="password"
                    value={editingCamera.password || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        password: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Stream URL */}
                <div className="flex flex-col gap-1">
                  <Label>Stream URL</Label>
                  <Input
                    value={editingCamera.streamUrl || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        streamUrl: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Stream Type */}
                <div className="flex flex-col gap-1">
                  <Label>Stream Type</Label>
                  <Input
                    value={editingCamera.streamType || ""}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        streamType: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Video Codec */}
                <div className="flex flex-col gap-1">
                  <Label>Video Codec</Label>
                  <Input
                    value={editingCamera.videoCodec || "h264"}
                    onChange={(e) =>
                      setEditingCamera({
                        ...editingCamera,
                        videoCodec: e.target.value,
                      })
                    }
                    placeholder="h264 or h265"
                  />
                </div>

              </div>

              <DialogFooter className="mt-4">
                <Button variant="outline" onClick={() => setEditingCamera(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    onUpdateCamera(editingCamera);
                    setEditingCamera(null);
                  }}
                >
                  Save Changes
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

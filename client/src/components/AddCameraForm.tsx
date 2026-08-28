import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface AddCameraFormProps {
  onSave: (camera: any) => void;
  onCancel?: () => void;
}

type TestStatus = "idle" | "testing" | "success" | "error";

// Updated vendor templates to include {port}
const vendorTemplates: Record<string, string> = {
  "CP Plus":
    "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}",
  "Hikvision":
    "rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}01/",
  "D-Link":
    "rtsp://{username}:{password}@{ip}:{port}/live{channel}.sdp",
  Others: "",
};

export default function AddCameraForm({ onSave, onCancel }: AddCameraFormProps) {
  const [cameraName, setCameraName] = useState("");
  const [channelId, setChannelId] = useState("");

  const [ipAddress, setIpAddress] = useState("");
  const [vendor, setVendor] = useState("");

  // NEW: dynamic PORT with default 554
  const [port, setPort] = useState("554");

  // NEW: Stream Mode
  const [streamMode, setStreamMode] = useState<"main" | "sub">("main");

  const [streamUrl, setStreamUrl] = useState("");
  const [streamType, setStreamType] = useState("RTSP");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [location, setLocation] = useState("");
  const [recordingPolicy, setRecordingPolicy] = useState("continuous");

  const [videoCodec, setVideoCodec] = useState<"h264" | "h265">("h264");
  const [codecManuallySet, setCodecManuallySet] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string>("");

  // 🔥 Auto-generate RTSP URL dynamically
  const updateRtspUrl = () => {
    if (vendor === "Others") return; // allow manual editing

    const template = vendorTemplates[vendor];
    if (!template) return;

    let channelString = channelId || "1";

    // MAIN vs SUB stream logic
    if (streamMode === "sub") {
      // CP Plus & Hikvision use subtype
      channelString = `${channelString}&subtype=1`;
    }

    const url = template
      .replace("{username}", username || "")
      .replace("{password}", password || "")
      .replace("{ip}", ipAddress || "")
      .replace("{port}", port || "554")
      .replace("{channel}", channelId || "1");

    setStreamUrl(url);
  };

  // Auto update on dependency changes
  useEffect(() => {
    updateRtspUrl();
  }, [ipAddress, username, password, vendor, port, channelId, streamMode]);

  const handleTestConnection = async () => {
    if (!streamUrl) {
      setTestStatus("error");
      setTestError("No stream URL to test");
      return;
    }

    setTestStatus("testing");
    setTestError("");
    try {
      const res = await apiRequest("POST", "/api/cameras/test-connection", { streamUrl });
      const result = await res.json();

      if (!result.ok) {
        setTestStatus("error");
        setTestError(result.error || "Connection failed");
        return;
      }

      setTestStatus("success");
      if (!codecManuallySet && result.detectedCodec) {
        setVideoCodec(result.detectedCodec);
      }
    } catch (err: any) {
      setTestStatus("error");
      setTestError(err?.message || "Connection failed");
    }
  };

  const handleSave = () => {
    onSave({
      name: cameraName,
      channelId,
      ipAddress,
      vendor,
      port,
      streamMode,
      streamUrl,
      streamType,
      videoCodec,
      username,
      password,
      location,
      recordingPolicy,
    });
  };

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="text-xl">Add New Camera</CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">

        {/* IP + Vendor + Port */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          
          <div className="space-y-2">
            <Label>IP Address</Label>
            <Input
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>

          <div className="space-y-2">
            <Label>Port</Label>
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="554"
            />
          </div>

          <div className="space-y-2">
            <Label>Vendor</Label>
            <Select value={vendor} onValueChange={(v) => setVendor(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select Vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CP Plus">CP Plus</SelectItem>
                <SelectItem value="Hikvision">Hikvision</SelectItem>
                <SelectItem value="D-Link">D-Link</SelectItem>
                <SelectItem value="Others">Others</SelectItem>
              </SelectContent>
            </Select>
          </div>

        </div>

        {/* Stream Mode */}
        <div className="space-y-2">
          <Label>Stream Mode</Label>
          <Select value={streamMode} onValueChange={(v: any) => setStreamMode(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select Mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="main">Main Stream</SelectItem>
              <SelectItem value="sub">Sub Stream</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Channel + Name */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          <div className="space-y-2">
            <Label>Channel ID</Label>
            <Input
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="1"
            />
          </div>

          <div className="space-y-2">
            <Label>Camera Name</Label>
            <Input
              value={cameraName}
              onChange={(e) => setCameraName(e.target.value)}
              placeholder="e.g., Front Door"
            />
          </div>

        </div>

        {/* RTSP URL */}
        <div className="space-y-2">
          <Label>RTSP/Stream URL</Label>
          <Input
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            disabled={vendor !== "Others"}
            placeholder="rtsp://..."
          />
        </div>

        {/* Stream Type + Video Codec */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Stream Type</Label>
            <Select value={streamType} onValueChange={setStreamType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="RTSP">RTSP</SelectItem>
                <SelectItem value="ONVIF">ONVIF</SelectItem>
                <SelectItem value="HLS">HLS</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Video Codec</Label>
            <Select
              value={videoCodec}
              onValueChange={(v: any) => {
                setVideoCodec(v);
                setCodecManuallySet(true);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="h264">H.264</SelectItem>
                <SelectItem value="h265">H.265 / HEVC</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Username / Password */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          <div className="space-y-2">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>

          <div className="space-y-2">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

        </div>

        {/* Location */}
        <div className="space-y-2">
          <Label>Location/Group</Label>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Building A - Floor 1"
          />
        </div>

        {/* Recording Policy */}
        <div className="space-y-2">
          <Label>Recording Policy</Label>
          <Select value={recordingPolicy} onValueChange={setRecordingPolicy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="continuous">Continuous</SelectItem>
              <SelectItem value="schedule">Schedule</SelectItem>
              <SelectItem value="motion">Motion-Based</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Test Connection */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={handleTestConnection}
            disabled={testStatus === "testing"}
          >
            {testStatus === "testing" && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Test Connection
          </Button>

          {testStatus === "success" && (
            <div className="flex items-center gap-2 text-success text-sm">
              <CheckCircle2 className="h-4 w-4" />
              <span>Connection successful</span>
            </div>
          )}

          {testStatus === "error" && (
            <div className="flex items-center gap-2 text-error text-sm">
              <XCircle className="h-4 w-4" />
              <span>{testError || "Connection failed"}</span>
            </div>
          )}
        </div>

        {/* Save / Cancel */}
        <div className="flex items-center gap-3 pt-4">
          <Button onClick={handleSave}>Save Camera</Button>

          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>

      </CardContent>
    </Card>
  );
}

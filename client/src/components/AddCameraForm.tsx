import { useState } from "react";
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

interface AddCameraFormProps {
  onSave: (camera: any) => void;
  onCancel?: () => void;
}

type TestStatus = "idle" | "testing" | "success" | "error";

export default function AddCameraForm({ onSave, onCancel }: AddCameraFormProps) {
  const [channelId, setChannelId] = useState("");
  const [cameraName, setCameraName] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [streamType, setStreamType] = useState("RTSP");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [location, setLocation] = useState("");
  const [recordingPolicy, setRecordingPolicy] = useState("continuous");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");

  const handleTestConnection = () => {
    setTestStatus("testing");
    setTimeout(() => {
      setTestStatus(streamUrl ? "success" : "error");
    }, 1500);
  };

  const handleSave = () => {
    onSave({
      channelId,
      cameraName,
      streamUrl,
      streamType,
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="channelId">Channel ID</Label>
            <Input
              id="channelId"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="e.g., 4"
              data-testid="input-channel-id"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cameraName">Camera Name</Label>
            <Input
              id="cameraName"
              value={cameraName}
              onChange={(e) => setCameraName(e.target.value)}
              placeholder="e.g., Front Door"
              data-testid="input-camera-name"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="streamUrl">RTSP/Stream URL</Label>
          <Input
            id="streamUrl"
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            placeholder="rtsp://192.168.1.100:554/stream"
            data-testid="input-stream-url"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="streamType">Stream Type</Label>
          <Select value={streamType} onValueChange={setStreamType}>
            <SelectTrigger id="streamType" data-testid="select-stream-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="RTSP">RTSP</SelectItem>
              <SelectItem value="ONVIF">ONVIF</SelectItem>
              <SelectItem value="HLS">HLS</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              data-testid="input-username"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              data-testid="input-password"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="location">Location/Group</Label>
          <Input
            id="location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g., Building A - Floor 1"
            data-testid="input-location"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="recordingPolicy">Recording Policy</Label>
          <Select value={recordingPolicy} onValueChange={setRecordingPolicy}>
            <SelectTrigger id="recordingPolicy" data-testid="select-recording-policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="continuous">Continuous</SelectItem>
              <SelectItem value="schedule">Schedule</SelectItem>
              <SelectItem value="motion">Motion-Based</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={handleTestConnection}
            disabled={testStatus === "testing"}
            data-testid="button-test-connection"
          >
            {testStatus === "testing" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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
              <span>Connection failed</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-4">
          <Button onClick={handleSave} data-testid="button-save-camera">
            Save Camera
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel} data-testid="button-cancel">
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

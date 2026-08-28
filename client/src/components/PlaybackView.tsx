import { useState, useEffect, useRef } from "react";
import { apiRequest } from "@/lib/queryClient";
import { browserSupportsH265File } from "@/lib/codecCapability";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Camera,
  Play,
  Pause,
  Download,
  Calendar as CalendarIcon,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { Camera as CameraType } from "./CameraCard";
import { useToast } from "@/hooks/use-toast";

interface Recording {
  id: string;
  cameraId: string;
  startTime: string;
  endTime: string;
  filePath: string;
  fileSize: number;
  duration: number;
}

interface PlaybackViewProps {
  cameras: CameraType[];
}

export default function PlaybackView({ cameras }: PlaybackViewProps) {
  const [selectedCamera, setSelectedCamera] = useState("");
  const [date, setDate] = useState<Date>();
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [playbackSpeed, setPlaybackSpeed] = useState("1");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentRecording, setCurrentRecording] = useState<Recording | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const { toast } = useToast();

  const hasSelection = selectedCamera && date && startTime && endTime;

  // Generate time options with 15-minute intervals
  const generateTimeOptions = () => {
    const times: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const hour = String(h).padStart(2, "0");
        const minute = String(m).padStart(2, "0");
        times.push(`${hour}:${minute}`);
      }
    }
    return times;
  };

  const timeOptions = generateTimeOptions();

  // End times at or before the start time wrap into the next day — a
  // 23:45 start must still offer a full range of end times (23:45→00:30
  // crossing midnight is a completely normal CCTV query).
  const endTimeIsNextDay = (time: string) => !!startTime && time <= startTime;

  const getValidEndTimes = () => {
    if (!startTime) return timeOptions;
    const after = timeOptions.filter((t) => t > startTime);
    const wrapped = timeOptions.filter((t) => t <= startTime);
    return [...after, ...wrapped];
  };

  // Fetch recordings when all filters are selected
  useEffect(() => {
    if (!hasSelection) {
      setRecordings([]);
      setCurrentRecording(null);
      return;
    }

    fetchRecordings();
  }, [selectedCamera, date, startTime, endTime]);

  // Update playback speed when changed
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = parseFloat(playbackSpeed);
    }
  }, [playbackSpeed]);

  const fetchRecordings = async () => {
    if (!date || !startTime || !endTime) return;

    setIsLoading(true);
    setCurrentRecording(null);
    
    try {
      const dateStr = format(date, "yyyy-MM-dd");
      const startDateTime = new Date(`${dateStr}T${startTime}:00`);
      const endDateTime = new Date(`${dateStr}T${endTime}:00`);
      // End times at or before the start wrap past midnight into the next day.
      if (endDateTime <= startDateTime) {
        endDateTime.setDate(endDateTime.getDate() + 1);
      }

      console.log(`📹 Fetching recordings from ${startDateTime.toISOString()} to ${endDateTime.toISOString()}`);

      const response = await apiRequest(
        "GET",
        `/api/cameras/${selectedCamera}/recordings?startDate=${startDateTime.toISOString()}&endDate=${endDateTime.toISOString()}`
      );

      const data = await response.json();
      setRecordings(data);

      if (data.length === 0) {
        toast({
          title: "📹 No Recordings Found",
          description: "No recordings available for the selected time range",
        });
      } else {
        // Load first recording
        setCurrentRecording(data[0]);
        toast({
          title: "✅ Recordings Loaded",
          description: `Found ${data.length} recording(s)`,
        });
      }
    } catch (error) {
      console.error("Failed to fetch recordings:", error);
      toast({
        title: "❌ Error",
        description: "Failed to load recordings",
        variant: "destructive",
      });
      setRecordings([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = async () => {
    if (recordings.length === 0) {
      toast({
        title: "⚠️ No Recording",
        description: "No recording available to export",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);

    try {
      const camera = cameras.find((c) => c.id === selectedCamera);
      
      for (const recording of recordings) {
        const downloadUrl = `/api/export/${recording.cameraId}/${recording.filePath}`;

        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = recording.filePath;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Small delay between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      toast({
        title: "✅ Export Started",
        description: `Downloading ${recordings.length} recording(s)`,
      });
    } catch (error) {
      console.error("Export failed:", error);
      toast({
        title: "❌ Export Failed",
        description: "Failed to export recordings",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  };

  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Select Camera */}
            <div className="space-y-2">
              <Label>Select Camera</Label>
              <Select value={selectedCamera} onValueChange={setSelectedCamera}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose camera..." />
                </SelectTrigger>
                <SelectContent>
                  {cameras.map((camera) => (
                    <SelectItem key={camera.id} value={camera.id}>
                      {camera.name} (CH {camera.channelId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Select Date */}
            <div className="space-y-2">
              <Label>Select Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {date ? format(date, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={setDate}
                    initialFocus
                    disabled={(date) => date > new Date()}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Start Time */}
            <div className="space-y-2">
              <Label>Start Time</Label>
              <Select value={startTime} onValueChange={setStartTime}>
                <SelectTrigger>
                  <SelectValue placeholder="00:00" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {timeOptions.map((time) => (
                    <SelectItem key={time} value={time}>
                      {time}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* End Time */}
            <div className="space-y-2">
              <Label>End Time</Label>
              <Select 
                value={endTime} 
                onValueChange={setEndTime}
                disabled={!startTime}
              >
                <SelectTrigger>
                  <SelectValue placeholder={startTime ? "Select end time" : "Select start first"} />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {getValidEndTimes().map((time) => (
                    <SelectItem key={time} value={time}>
                      {time}
                      {endTimeIsNextDay(time) ? " (next day)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Playback Speed */}
            <div className="space-y-2">
              <Label>Playback Speed</Label>
              <Select value={playbackSpeed} onValueChange={setPlaybackSpeed}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.5">0.5x</SelectItem>
                  <SelectItem value="1">1x</SelectItem>
                  <SelectItem value="1.5">1.5x</SelectItem>
                  <SelectItem value="2">2x</SelectItem>
                  <SelectItem value="4">4x</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading State */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center h-96 border border-border rounded-md bg-card">
          <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
          <p className="text-sm text-muted-foreground">Loading recordings...</p>
        </div>
      )}

      {/* Empty State */}
      {!hasSelection && !isLoading && (
        <div className="flex flex-col items-center justify-center h-96 border border-border rounded-md bg-card">
          <Camera className="h-16 w-16 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold">Select camera, date & time</h3>
          <p className="text-sm text-muted-foreground">
            Choose all fields to view footage
          </p>
        </div>
      )}

      {/* Playback View */}
      {hasSelection && !isLoading && recordings.length > 0 && (
        <div className="space-y-4">
          {/* Recording Info & Export */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {recordings.length} recording{recordings.length !== 1 ? 's' : ''} found
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format(date!, "PPP")} • {startTime} - {endTime}
                    {endTime && endTimeIsNextDay(endTime) ? " (next day)" : ""}
                  </p>
                </div>
                <Button 
                  size="sm" 
                  onClick={handleExport}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-2" />
                      Export All
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Video Player — H.265 recordings fall back to the server's H.264
              variant when this browser has no HEVC decoder */}
          <div className="relative bg-black aspect-video rounded-md overflow-hidden">
            {currentRecording ? (
              <video
                ref={videoRef}
                key={currentRecording.id}
                className="w-full h-full"
                controls
                autoPlay
                src={`/api/recordings/${currentRecording.cameraId}/${currentRecording.filePath}${
                  cameras.find((c) => c.id === currentRecording.cameraId)?.videoCodec === "h265" &&
                  !browserSupportsH265File()
                    ? "?codec=h264"
                    : ""
                }`}
              >
                Your browser does not support the video tag.
              </video>
            ) : (
              <div className="flex items-center justify-center h-full">
                <Camera className="h-24 w-24 text-muted-foreground opacity-20" />
              </div>
            )}
          </div>

          {/* Recording Segments List */}
          {recordings.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">
                  Recording Segments ({recordings.length})
                </h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {recordings.map((recording, index) => (
                    <button
                      key={recording.id}
                      onClick={() => setCurrentRecording(recording)}
                      className={`w-full text-left p-3 rounded-md transition-colors border ${
                        currentRecording?.id === recording.id
                          ? 'bg-primary/10 border-primary'
                          : 'hover:bg-muted border-border'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">Segment {index + 1}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatTime(recording.startTime)} - {formatTime(recording.endTime)}
                          </p>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatFileSize(recording.fileSize)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* No Recordings Found */}
      {hasSelection && !isLoading && recordings.length === 0 && (
        <div className="flex flex-col items-center justify-center h-96 border border-border rounded-md bg-card">
          <Camera className="h-16 w-16 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold">No Recordings Found</h3>
          <p className="text-sm text-muted-foreground">
            No recordings available for the selected time range
          </p>
        </div>
      )}
    </div>
  );
}
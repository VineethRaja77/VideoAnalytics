import { useState } from "react";
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
import { Camera, Play, Pause, SkipForward, SkipBack, Download, Calendar as CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { Camera as CameraType } from "./CameraCard";

interface PlaybackViewProps {
  cameras: CameraType[];
}

export default function PlaybackView({ cameras }: PlaybackViewProps) {
  const [selectedCamera, setSelectedCamera] = useState("");
  const [date, setDate] = useState<Date>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState("1");
  const [progress, setProgress] = useState(0);

  const hasSelection = selectedCamera && date;

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
    console.log(isPlaying ? "Pause" : "Play");
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Select Camera</Label>
              <Select value={selectedCamera} onValueChange={setSelectedCamera}>
                <SelectTrigger data-testid="select-camera">
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

            <div className="space-y-2">
              <Label>Select Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                    data-testid="button-select-date"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {date ? format(date, "PPP") : <span>Pick a date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={setDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label>Playback Speed</Label>
              <Select value={playbackSpeed} onValueChange={setPlaybackSpeed}>
                <SelectTrigger data-testid="select-speed">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.5">0.5x</SelectItem>
                  <SelectItem value="1">1x</SelectItem>
                  <SelectItem value="2">2x</SelectItem>
                  <SelectItem value="4">4x</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {!hasSelection ? (
        <div className="flex flex-col items-center justify-center h-96 border border-border rounded-md bg-card">
          <Camera className="h-16 w-16 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">Select a camera and date</h3>
          <p className="text-sm text-muted-foreground">Choose a camera and date to view footage</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="relative bg-black aspect-video rounded-md flex items-center justify-center">
            <Camera className="h-24 w-24 text-muted-foreground opacity-20" />
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
              <div className="space-y-3">
                <div className="relative h-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className="absolute left-0 top-0 h-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={progress}
                    onChange={(e) => setProgress(Number(e.target.value))}
                    className="absolute inset-0 w-full opacity-0 cursor-pointer"
                    data-testid="slider-timeline"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => console.log("Skip back")}
                      data-testid="button-skip-back"
                    >
                      <SkipBack className="h-5 w-5" />
                    </Button>
                    <Button
                      size="icon"
                      onClick={handlePlayPause}
                      data-testid="button-play-pause"
                    >
                      {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => console.log("Skip forward")}
                      data-testid="button-skip-forward"
                    >
                      <SkipForward className="h-5 w-5" />
                    </Button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white">
                      {format(date, "HH:mm:ss")}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => console.log("Export")}
                      data-testid="button-export"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Export
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

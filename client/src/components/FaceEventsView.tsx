// Face recognition events — recognised people and unknown faces.
//
// "Unknown" is a first-class result here, not a failure: the worker reports it
// whenever no enrolled person clears the similarity threshold, or when two
// candidates are too close to separate. The table shows the similarity and the
// runner-up so an operator can see WHY something was called unknown, rather
// than being told an identity the system was not actually confident about.
//
// Unknown faces are acknowledgeable (they are the security-relevant signal);
// recognised staff are informational.

import { useState } from "react";
import { ScanFace, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, canWrite } from "@/lib/auth";
import EnrolFromEventDialog from "@/components/EnrolFromEventDialog";
import { Badge } from "@/components/ui/badge";
import ModuleEventsView, {
  cameraName,
  SnapshotCell,
  type AnalyticsEvent,
  type CameraLite,
  type EventColumn,
} from "@/components/ModuleEventsView";
import { formatDateTime } from "@/lib/datetime";

export default function FaceEventsView({
  cameras,
  hideHeading = false,
}: {
  cameras: CameraLite[];
  hideHeading?: boolean;
}) {
  const auth = useAuth();
  const writable = canWrite(auth.role);
  // The event whose person is being named. An unknown-face alert is a
  // question, and this is where it gets answered.
  const [naming, setNaming] = useState<AnalyticsEvent | null>(null);

  const columns: EventColumn[] = [
    {
      header: "Time",
      className: "whitespace-nowrap",
      cell: (e) => formatDateTime(e.createdAt),
    },
    { header: "Camera", cell: (e) => cameraName(cameras, e.cameraId) },
    {
      header: "Person",
      cell: (e) => {
        const person = e.details?.person;
        if (!person) return <span className="text-muted-foreground">—</span>;
        const unknown = person === "unknown";
        return (
          <Badge variant={unknown ? "destructive" : "outline"} className="capitalize">
            {unknown ? "Unknown" : person}
          </Badge>
        );
      },
    },
    {
      header: "Match",
      className: "text-xs",
      cell: (e) => {
        const sim = e.details?.similarity;
        const runner = e.details?.runnerUp;
        if (sim == null) return <span className="text-muted-foreground">—</span>;
        return (
          <span>
            {Number(sim).toFixed(3)}
            {runner != null && (
              <span className="text-muted-foreground"> (next {Number(runner).toFixed(3)})</span>
            )}
          </span>
        );
      },
    },
    {
      header: "Confidence",
      className: "text-xs",
      cell: (e) => {
        // `locked` means the identity has held across enough frames to be
        // settled. NOT being locked yet is not a warning — the first event for
        // any appearance is always unlocked, so showing it in amber put a
        // caution on essentially every row and trained operators to ignore the
        // column. Amber is now reserved for the case that genuinely deserves
        // it: frames that DISAGREE about who this is.
        const locked = e.details?.locked;
        const vote = e.details?.voteConfidence;
        if (locked === undefined) return <span className="text-muted-foreground">—</span>;
        const agreement = vote == null ? null : Math.round(Number(vote) * 100);
        const disputed = agreement != null && agreement < 80;
        return (
          <span
            className={
              disputed
                ? "text-amber-600 dark:text-amber-500"
                : locked
                ? "text-green-600 dark:text-green-500"
                : "text-muted-foreground"
            }
            title={
              locked
                ? "Held steady across enough frames to be settled."
                : "Reported early, before the identity had settled across frames."
            }
          >
            {locked ? "confirmed" : "still settling"}
            {/* Only shown when it is informative: unanimous frames say nothing. */}
            {disputed && ` · frames disagree (${agreement}%)`}
          </span>
        );
      },
    },
    {
      header: "Face size",
      className: "text-xs",
      cell: (e) => {
        // Interocular distance is the honest quality signal: below ~40 px no
        // model can identify a face, so surfacing it explains weak matches and
        // flags a badly-placed camera.
        const px = e.details?.eyeDistancePx;
        if (px == null) return <span className="text-muted-foreground">—</span>;
        const n = Number(px);
        const cls = n >= 80 ? "text-green-600" : n >= 40 ? "text-amber-600" : "text-destructive";
        return <span className={cls}>{n.toFixed(0)} px</span>;
      },
    },
    { header: "Snapshot", cell: (e) => <SnapshotCell event={e} /> },
    {
      header: "Identify",
      className: "whitespace-nowrap",
      cell: (e) => {
        // Only offered where it means something: an unrecognised face, an image
        // to look at, and the right to change the gallery. A snapshot only
        // exists if storing images of unidentified people was switched on.
        if (e.details?.person !== "unknown") {
          return <span className="text-muted-foreground">—</span>;
        }
        if (!e.snapshot) {
          return (
            <span
              className="text-xs text-muted-foreground"
              title="Images of unrecognised people are not being stored, so there is nothing to enrol from."
            >
              no image
            </span>
          );
        }
        if (!writable) return <span className="text-muted-foreground">—</span>;
        return (
          <Button
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => setNaming(e)}
            data-testid={`identify-${e.id}`}
          >
            <UserPlus className="mr-1 h-4 w-4" />
            Who is this?
          </Button>
        );
      },
    },
  ];

  return (
    <>
    <EnrolFromEventDialog event={naming} onClose={() => setNaming(null)} />
    <ModuleEventsView
      module="face"
      title="Face Recognition"
      subtitle="Recognised people and unknown faces"
      icon={<ScanFace className="h-5 w-5 text-primary" />}
      columns={columns}
      cameras={cameras}
      hideHeading={hideHeading}
      emptyText="No face events yet. Enrol people under 'Enrolled people', then enable Face Recognition on a camera in Analytics Setup."
    />
    </>
  );
}

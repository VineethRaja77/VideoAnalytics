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

import { ScanFace } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ModuleEventsView, {
  cameraName,
  SnapshotCell,
  type CameraLite,
  type EventColumn,
} from "@/components/ModuleEventsView";

export default function FaceEventsView({ cameras }: { cameras: CameraLite[] }) {
  const columns: EventColumn[] = [
    {
      header: "Time",
      className: "whitespace-nowrap",
      cell: (e) => new Date(e.createdAt).toLocaleString(),
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
        const locked = e.details?.locked;
        const vote = e.details?.voteConfidence;
        if (locked === undefined) return <span className="text-muted-foreground">—</span>;
        return (
          <span className={locked ? "text-green-600" : "text-amber-600"}>
            {locked ? "confirmed" : "provisional"}
            {vote != null && ` · ${Math.round(Number(vote) * 100)}%`}
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
  ];

  return (
    <ModuleEventsView
      module="face"
      title="Face Recognition"
      subtitle="Recognised people and unknown faces"
      icon={<ScanFace className="h-5 w-5 text-primary" />}
      columns={columns}
      cameras={cameras}
      emptyText="No face events yet. Enrol people (models/face/enroll.py) and enable the face module on a camera."
    />
  );
}

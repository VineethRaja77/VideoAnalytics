// Vehicle events — line crossings and periodic count summaries.
//
// Columns reflect what the vehicle worker actually emits (see
// models/vehicle/events.py): vehicleType from the per-track VOTE (not a single
// frame), direction, and whether the class was locked. Surfacing "locked" and
// "stability" matters operationally: an unlocked class means the track was too
// short or genuinely ambiguous, so the type is a best guess rather than settled.

import { Car } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ModuleEventsView, {
  cameraName,
  prettyType,
  SnapshotCell,
  type CameraLite,
  type EventColumn,
} from "@/components/ModuleEventsView";
import { formatDateTime } from "@/lib/datetime";

const TYPE_COLOR: Record<string, string> = {
  two_wheeler: "bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200",
  three_wheeler: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/30 dark:text-fuchsia-200",
  car: "bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200",
  van: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/30 dark:text-cyan-200",
  lcv: "bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-200",
  truck: "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200",
  bus: "bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200",
  bicycle: "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-200",
};

export default function VehicleEventsView({ cameras, compact = false }: { cameras: CameraLite[]; compact?: boolean }) {
  const columns: EventColumn[] = [
    {
      header: "Time",
      className: "whitespace-nowrap",
      cell: (e) => formatDateTime(e.createdAt),
    },
    { header: "Camera", cell: (e) => cameraName(cameras, e.cameraId) },
    {
      header: "Vehicle",
      cell: (e) => {
        // A count summary carries no single vehicle type.
        if (e.type === "vehicle_count_summary") {
          const counts = e.details?.counts ?? {};
          const entries = Object.entries(counts) as [string, number][];
          if (!entries.length) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="flex flex-wrap gap-1">
              {entries.map(([k, v]) => (
                <Badge key={k} variant="outline" className={`text-xs ${TYPE_COLOR[k] ?? ""}`}>
                  {k.replace(/_/g, " ")}: {v}
                </Badge>
              ))}
            </span>
          );
        }
        const t = e.details?.vehicleType;
        if (!t) return <span className="text-muted-foreground">—</span>;
        return (
          <Badge variant="outline" className={`capitalize ${TYPE_COLOR[t] ?? ""}`}>
            {String(t).replace(/_/g, " ")}
          </Badge>
        );
      },
    },
    {
      header: "Direction",
      cell: (e) =>
        e.details?.direction ? (
          <Badge variant="secondary" className="text-xs uppercase">
            {e.details.direction}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: "Class confidence",
      className: "text-xs",
      cell: (e) => {
        if (e.type === "vehicle_count_summary") return <span className="text-muted-foreground">—</span>;
        const locked = e.details?.classLocked;
        const stability = e.details?.classStability;
        if (locked === undefined) return <span className="text-muted-foreground">—</span>;
        return (
          <span className={locked ? "text-green-600" : "text-amber-600"}>
            {locked ? "locked" : "provisional"}
            {stability != null && ` · ${Math.round(Number(stability) * 100)}%`}
          </span>
        );
      },
    },
    {
      header: "Event",
      cell: (e) => <span className="text-xs text-muted-foreground">{prettyType(e.type)}</span>,
    },
    { header: "Snapshot", cell: (e) => <SnapshotCell event={e} /> },
  ];

  return (
    <ModuleEventsView
      module="vehicle"
      title="Vehicle Detection"
      subtitle="Line crossings and traffic counts"
      icon={<Car className="h-5 w-5 text-primary" />}
      columns={columns}
      cameras={cameras}
      // Counting is telemetry, not an alert queue — nothing to acknowledge.
      ackable={false}
      hideHeading={compact}
      emptyText="No vehicle events yet. Enable the vehicle module on a camera and set a counting line."
    />
  );
}

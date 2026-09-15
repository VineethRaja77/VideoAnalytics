// People & intrusion events — the seven person analytics in one table.
//
// They share a screen because they share a worker and a subject: everything
// here is "something a person did in a place". Splitting intrusion from
// loitering would make an operator watch two tabs for the same camera.
//
// WHAT THE COLUMNS ARE FOR
//   The point of a security event list is to let someone decide FAST whether to
//   act. So the severity of the event type leads, the detail column says the
//   one number that matters for that type (seconds loitered, people crossed,
//   how long someone has been down), and the snapshot is one click away.
//
// Only events the client is licensed for can exist: the worker never
// constructs an unlicensed rule, so nothing unlicensed reaches this table.

import { UserSquare } from "lucide-react";
import { MODULE_FEATURES } from "@shared/schema";
import ModuleCoverage from "@/components/ModuleCoverage";
import { Badge } from "@/components/ui/badge";
import ModuleEventsView, {
  cameraName,
  prettyType,
  SnapshotCell,
  type AnalyticsEvent,
  type CameraLite,
  type EventColumn,
} from "@/components/ModuleEventsView";
import { formatDateTime } from "@/lib/datetime";

/**
 * How loud each event type is.
 *
 * An intrusion and a routine occupancy summary must not look the same in a
 * list an operator scans in a hurry. Anything not listed is informational —
 * a new event type from a newer worker shows up quietly rather than as an
 * unstyled blank, and never as a false alarm.
 */
const SEVERITY: Record<string, "critical" | "warning" | "info"> = {
  intrusion: "critical",
  fall: "critical",
  tailgating: "warning",
  loitering: "warning",
  crowd_density: "warning",
  people_crossed: "info",
  people_count_summary: "info",
  queue_status: "info",
};

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-destructive text-destructive-foreground",
  warning:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 border-transparent",
  info: "bg-secondary text-secondary-foreground",
};

/** The single number that matters, per event type. */
function detailFor(e: AnalyticsEvent): React.ReactNode {
  const d = e.details ?? {};
  switch (e.type) {
    case "intrusion":
      return (
        <span>
          in the restricted area for{" "}
          <span className="font-medium">{d.framesInside ?? "?"} frames</span>
        </span>
      );
    case "loitering":
      return (
        <span>
          standing for{" "}
          <span className="font-medium">{Math.round(Number(d.dwellSeconds ?? 0))}s</span>
        </span>
      );
    case "fall":
      return (
        <span>
          down for{" "}
          <span className="font-medium">{Math.round(Number(d.downSeconds ?? 0))}s</span>
          {/* Said out loud because it is a box-geometry heuristic, not a pose
              model. An operator should verify before dispatching anyone. */}
          <span className="text-muted-foreground"> · needs verification</span>
        </span>
      );
    case "crowd_density":
      return (
        <span>
          <span className="font-medium">{d.count}</span> people in the zone (limit{" "}
          {d.limit})
        </span>
      );
    case "tailgating":
      return (
        <span>
          <span className="font-medium">{d.peopleInWindow}</span> people crossed within{" "}
          {d.windowSeconds}s
        </span>
      );
    case "people_crossed":
      return <span>one person {d.direction === "in" ? "entered" : "left"}</span>;
    case "people_count_summary":
      return (
        <span>
          <span className="font-medium">{d.in ?? 0} in</span> ·{" "}
          <span className="font-medium">{d.out ?? 0} out</span> · {d.occupancy ?? 0} present
        </span>
      );
    case "queue_status":
      return (
        <span>
          <span className="font-medium">{d.queueLength ?? 0}</span> waiting · average{" "}
          {Math.round(Number(d.avgWaitSeconds ?? 0))}s, longest{" "}
          {Math.round(Number(d.maxWaitSeconds ?? 0))}s
        </span>
      );
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}

export default function PersonEventsView({ cameras, compact = false }: { cameras: CameraLite[]; compact?: boolean }) {
  const columns: EventColumn[] = [
    {
      header: "Time",
      className: "whitespace-nowrap",
      cell: (e) => formatDateTime(e.createdAt),
    },
    { header: "Camera", cell: (e) => cameraName(cameras, e.cameraId) },
    {
      header: "Event",
      cell: (e) => {
        const sev = SEVERITY[e.type] ?? "info";
        return (
          <Badge className={`capitalize ${SEVERITY_STYLE[sev]}`}>
            {prettyType(e.type)}
          </Badge>
        );
      },
    },
    { header: "Detail", cell: detailFor },
    {
      header: "Track",
      className: "text-xs text-muted-foreground",
      // The track id is how an operator ties several events to ONE person
      // reviewing footage afterwards; summary events have none.
      cell: (e) => (e.trackId != null ? `#${e.trackId}` : "—"),
    },
    { header: "Snapshot", cell: (e) => <SnapshotCell event={e} /> },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {!compact && (
        <ModuleCoverage
          features={MODULE_FEATURES.person}
          cameras={cameras}
          what="People &amp; intrusion"
        />
      )}
      <ModuleEventsView
      module="person"
      title="People & Intrusion"
      subtitle="Intrusion, loitering, falls, crowding, queues and footfall"
      icon={<UserSquare className="h-5 w-5 text-primary" />}
      columns={columns}
      cameras={cameras}
      hideHeading={compact}
      emptyText="No people events yet."
    />
    </div>
  );
}

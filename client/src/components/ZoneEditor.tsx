// Draw an intrusion zone (or a counting line) on what the camera actually sees.
//
// WHY A LIVE FRAME AND NOT A DIAGRAM
//   A restricted area only means something in the camera's own pixels. The
//   backdrop here is fetched from GET /api/cameras/:id/frame, which decodes a
//   frame with the SAME OpenCV capture the analytics worker uses, so a corner
//   clicked here is the same corner the rule tests. Drawing against a resized
//   preview and storing the coordinates unscaled would put the zone somewhere
//   else entirely in the frame the worker evaluates — and the only symptom
//   would be alerts for the wrong part of the site, with nothing in any log.
//
// WHY SVG AND NOT <canvas>
//   Every corner is a real DOM element, so it can be tabbed to, nudged with
//   the arrow keys and deleted with a keyboard — a canvas would be a black box
//   to anyone not using a mouse. The viewBox is the frame's true pixel size, so
//   the browser does all the scaling and the stored numbers are always in
//   worker coordinates whatever size the panel is rendered at.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Camera as CameraIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  formatAreas,
  formatGeometry,
  parseAreas,
  parseGeometry,
  validateGeometry,
  type Point,
} from "@shared/analyticsConfig";

interface Frame {
  /** The JPEG itself, NOT an object URL.
   *
   *  React Query caches this object. An object URL stored here would be revoked
   *  when the component unmounted and then handed back — already dead — on the
   *  next mount inside the cache window, showing a broken image. The URL is
   *  therefore created and revoked by the component that displays it. */
  blob: Blob;
  width: number;
  height: number;
}

interface Props {
  cameraId: string;
  configKey: string;
  kind: "polygon" | "line";
  label: string;
  help: string;
  value: string;
  onChange: (spec: string) => void;
  disabled?: boolean;
}

/** Corner radius in FRAME pixels, scaled so handles stay grabbable on a 4K feed. */
const handleRadius = (w: number) => Math.max(5, Math.round(w / 130));

export default function ZoneEditor({
  cameraId,
  configKey,
  kind,
  label,
  help,
  value,
  onChange,
  disabled = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  // A camera can carry SEVERAL restricted areas — a yard covers a fuel store
  // and a transformer bay, and forcing them into one polygon means either
  // covering the walkway between them or leaving one unwatched.
  //
  // A line is different: one line is one line, so it stays a single shape.
  const areas = useMemo<Point[][]>(() => {
    try {
      const parsed = kind === "line" ? [parseGeometry(value)] : parseAreas(value);
      return parsed.filter((a) => a.length > 0);
    } catch {
      return [];
    }
  }, [value, kind]);

  // Which area new clicks land in. Always the last one, so "Add another area"
  // followed by clicking just works without a mode to remember.
  const [editing, setEditing] = useState(0);
  const activeIndex = Math.min(editing, Math.max(0, areas.length - 1));
  const points = areas[activeIndex] ?? [];

  const parseError = useMemo(() => {
    try {
      if (kind === "line") parseGeometry(value);
      else parseAreas(value);
    } catch (e: any) {
      return `Saved value could not be read (${e.message}). Redraw it.`;
    }
    return validateGeometry(configKey, value);
  }, [value, configKey, kind]);

  // "New frame" must bypass the server's short-lived cache; the first load
  // should not, because several editors on one page would otherwise each open
  // their own RTSP session for the same camera.
  const forceNext = useRef(false);

  const {
    data: frame,
    error: frameError,
    isFetching,
    refetch,
  } = useQuery<Frame, ApiError>({
    queryKey: ["camera-frame", cameraId],
    queryFn: async () => {
      const force = forceNext.current;
      forceNext.current = false;
      const res = await apiRequest(
        "GET",
        `/api/cameras/${cameraId}/frame${force ? "?refresh=1" : ""}`
      );
      return {
        blob: await res.blob(),
        // The server reports the DECODED size. Falling back to 0 would make
        // every click land at the same place, so the overlay is not drawn at
        // all until a real size is known.
        width: Number(res.headers.get("X-Frame-Width")) || 0,
        height: Number(res.headers.get("X-Frame-Height")) || 0,
      };
    },
    retry: false,
    staleTime: 60_000,
  });

  // Object URLs are never reclaimed on their own; without this every refresh
  // leaks a full-resolution JPEG for the life of the tab.
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!frame?.blob) {
      setImgUrl(null);
      return;
    }
    const url = URL.createObjectURL(frame.blob);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [frame?.blob]);

  const maxPoints = kind === "line" ? 2 : Infinity;
  const complete =
    kind === "line" ? points.length === 2 : areas.some((a) => a.length >= 3);

  /** Replace the area being edited and write the whole value back. */
  const commit = useCallback(
    (next: Point[]) => {
      if (kind === "line") return onChange(formatGeometry(next));
      const all = areas.slice();
      if (activeIndex < all.length) all[activeIndex] = next;
      else all.push(next);
      onChange(formatAreas(all));
    },
    [onChange, areas, activeIndex, kind]
  );

  const removeArea = (i: number) => {
    onChange(formatAreas(areas.filter((_, j) => j !== i)));
    setEditing(0);
    setSelected(null);
  };

  /** Pointer position in FRAME pixels, clamped to the frame. */
  const toFrame = useCallback(
    (e: { clientX: number; clientY: number }): Point | null => {
      const svg = svgRef.current;
      if (!svg || !frame?.width || !frame?.height) return null;
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.min(frame.width, Math.max(0, ((e.clientX - r.left) / r.width) * frame.width)),
        y: Math.min(frame.height, Math.max(0, ((e.clientY - r.top) / r.height) * frame.height)),
      };
    },
    [frame?.width, frame?.height]
  );

  const addPoint = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || dragging !== null) return;
    if (points.length >= maxPoints) return;
    const p = toFrame(e);
    if (p) {
      commit([...points, p]);
      setSelected(points.length);
    }
  };

  const movePoint = useCallback(
    (i: number, p: Point) => {
      const next = points.slice();
      next[i] = p;
      commit(next);
    },
    [points, commit]
  );

  const removePoint = (i: number) => {
    commit(points.filter((_, j) => j !== i));
    setSelected(null);
  };

  // Dragging is tracked on the window, not the handle: releasing the pointer
  // outside the image would otherwise leave a corner stuck to the cursor.
  useEffect(() => {
    if (dragging === null) return;
    const move = (e: PointerEvent) => {
      const p = toFrame(e);
      if (p) movePoint(dragging, p);
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, toFrame, movePoint]);

  /** Keyboard equivalent of dragging a corner. Shift = coarse. */
  const onHandleKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.shiftKey ? 10 : 1;
    const deltas: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    if (deltas[e.key]) {
      e.preventDefault();
      const d = deltas[e.key];
      movePoint(i, {
        x: Math.min(frame?.width ?? 0, Math.max(0, points[i].x + d.x)),
        y: Math.min(frame?.height ?? 0, Math.max(0, points[i].y + d.y)),
      });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removePoint(i);
    }
  };

  const r = handleRadius(frame?.width || 640);
  const stroke = Math.max(2, Math.round((frame?.width || 640) / 320));
  const path = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">{label}</h4>
            {complete ? (
              <Badge variant="secondary" className="text-xs">
                {kind === "line"
                  ? "Line set"
                  : areas.length === 1
                  ? `${areas[0].length} corners`
                  : `${areas.length} areas`}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Not drawn
              </Badge>
            )}
          </div>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{help}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => {
              forceNext.current = true;
              void refetch();
            }}
            disabled={isFetching}
            data-testid="zone-refresh-frame"
          >
            {isFetching ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            New frame
          </Button>
          {kind === "polygon" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="cursor-pointer"
              // Disabled until the current shape is a real area, so a stray
              // click cannot leave an empty area behind that saves as nothing.
              disabled={disabled || points.length < 3}
              onClick={() => {
                setEditing(areas.length);
                setSelected(null);
              }}
              data-testid="zone-add-area"
            >
              <Plus className="mr-1 h-4 w-4" />
              Another area
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => commit(points.slice(0, -1))}
            disabled={disabled || !points.length}
            data-testid="zone-undo"
          >
            <Undo2 className="mr-1 h-4 w-4" />
            Undo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer text-destructive"
            onClick={() => {
              onChange("");
              setEditing(0);
              setSelected(null);
            }}
            disabled={disabled || !areas.length}
            data-testid="zone-clear"
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {areas.length > 1 ? "Clear all" : "Clear"}
          </Button>
        </div>
      </div>

      {/* ---- the picture ---- */}
      <div className="relative overflow-hidden rounded-md border bg-muted">
        {frameError && (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="space-y-2">
                {/* The server distinguishes "could not open the stream" from
                    "opened but produced no frame". That difference is the whole
                    value of the message — it points at the network or at the
                    codec — so it is shown verbatim. */}
                <p>{frameError.message}</p>
                <p className="text-xs opacity-90">
                  A zone can still be drawn once a frame is available. Nothing is
                  saved until you press Save.
                </p>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {!frameError && !imgUrl && (
          <div className="flex aspect-video items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting to the camera…
          </div>
        )}

        {frame && imgUrl && (
          <div className="relative">
            <img
              src={imgUrl}
              alt={`Current view from this camera, ${frame.width} by ${frame.height} pixels`}
              className="block w-full select-none"
              draggable={false}
            />
            {frame.width > 0 && frame.height > 0 && (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${frame.width} ${frame.height}`}
                className={`absolute inset-0 h-full w-full touch-none ${
                  disabled || points.length >= maxPoints
                    ? "cursor-default"
                    : "cursor-crosshair"
                }`}
                onPointerDown={addPoint}
                role="application"
                aria-label={`${label} editor. Click to add a corner; each corner can be focused and moved with the arrow keys.`}
              >
                {/* Every area is drawn, not just the one being edited — an
                    operator adding a second area has to see the first one to
                    place it sensibly. The inactive ones are dimmed so it stays
                    obvious where a click will land. */}
                {kind === "polygon" &&
                  areas.map((a, i) =>
                    a.length > 1 ? (
                      <g key={`area-${i}`}>
                        <polygon
                          points={a.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill={
                            i === activeIndex
                              ? "hsl(var(--destructive) / 0.22)"
                              : "hsl(var(--destructive) / 0.10)"
                          }
                          stroke="hsl(var(--destructive))"
                          strokeWidth={i === activeIndex ? stroke : stroke * 0.6}
                          strokeOpacity={i === activeIndex ? 1 : 0.55}
                          strokeLinejoin="round"
                        />
                        {areas.length > 1 && (
                          <text
                            x={a.reduce((t, p) => t + p.x, 0) / a.length}
                            y={a.reduce((t, p) => t + p.y, 0) / a.length}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fontSize={Math.max(14, (frame?.width ?? 640) / 32)}
                            fill="white"
                            stroke="black"
                            strokeWidth={Math.max(1, stroke / 3)}
                            paintOrder="stroke"
                            style={{ pointerEvents: "none", fontWeight: 700 }}
                          >
                            {i + 1}
                          </text>
                        )}
                      </g>
                    ) : null
                  )}

                {kind === "line" && points.length > 1 && (
                  <polyline
                    points={path}
                    fill="none"
                    stroke="hsl(var(--primary))"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                  />
                )}

                {points.map((p, i) => (
                  <g key={i}>
                    {/* White ring first: a coloured dot alone disappears against
                        a busy site scene, which is most real camera views. */}
                    <circle cx={p.x} cy={p.y} r={r + stroke} fill="white" opacity={0.9} />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      className={`${disabled ? "" : "cursor-grab"} outline-none`}
                      fill={
                        selected === i
                          ? "hsl(var(--primary))"
                          : kind === "polygon"
                          ? "hsl(var(--destructive))"
                          : "hsl(var(--primary))"
                      }
                      stroke={selected === i ? "hsl(var(--primary))" : "transparent"}
                      strokeWidth={stroke * 2}
                      tabIndex={disabled ? -1 : 0}
                      role="button"
                      aria-label={`Corner ${i + 1} at ${Math.round(p.x)}, ${Math.round(
                        p.y
                      )}. Arrow keys move it, Delete removes it.`}
                      onFocus={() => setSelected(i)}
                      onKeyDown={(e) => onHandleKey(e, i)}
                      onPointerDown={(e) => {
                        if (disabled) return;
                        e.stopPropagation(); // do not also add a new corner
                        setDragging(i);
                        setSelected(i);
                      }}
                      data-testid={`zone-handle-${i}`}
                    />
                  </g>
                ))}
              </svg>
            )}
          </div>
        )}
      </div>

      {/* ---- the areas, as a list ---- */}
      {kind === "polygon" && areas.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="zone-area-list">
          {areas.map((a, i) => (
            <li key={i}>
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                  i === activeIndex ? "border-destructive bg-destructive/10" : ""
                }`}
              >
                <button
                  type="button"
                  className="cursor-pointer font-medium"
                  onClick={() => {
                    setEditing(i);
                    setSelected(null);
                  }}
                  // The canvas is not the only way in: this makes each area
                  // selectable and removable with a keyboard alone.
                  aria-pressed={i === activeIndex}
                  data-testid={`zone-select-area-${i}`}
                >
                  Area {i + 1}
                  <span className="ml-1 font-normal text-muted-foreground">
                    {a.length} corners
                  </span>
                </button>
                {!disabled && (
                  <button
                    type="button"
                    className="cursor-pointer text-muted-foreground hover:text-destructive"
                    aria-label={`Remove area ${i + 1}`}
                    onClick={() => removeArea(i)}
                    data-testid={`zone-remove-area-${i}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ---- what will actually be stored ---- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CameraIcon className="h-3.5 w-3.5" />
          {frame?.width
            ? `${frame.width} x ${frame.height} px — the same frame the detector reads`
            : "frame size unknown"}
        </span>
        {points.length > 0 && (
          <code className="truncate font-mono" title={value}>
            {configKey}={value}
          </code>
        )}
      </div>

      {kind === "polygon" && points.length > 0 && points.length < 3 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Area {activeIndex + 1} needs at least 3 corners. With {points.length} it
          cannot be saved.
        </p>
      )}
      {kind === "polygon" && areas.length > 1 && (
        <p className="text-xs text-muted-foreground">
          A person inside <strong>any</strong> of these areas raises an alert. The
          space between them does not.
        </p>
      )}
      {kind === "line" && points.length === 1 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Click once more to finish the line.
        </p>
      )}
      {parseError && (
        <p className="text-xs text-destructive" role="alert">
          {parseError}
        </p>
      )}
    </div>
  );
}

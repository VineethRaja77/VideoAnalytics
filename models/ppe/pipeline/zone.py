"""Stage 3: zone / line-crossing trigger.

Only run the (expensive) PPE checks on workers who have entered the restricted
area. The line is two image-space points; a worker is 'inside' when the bottom
-centre of their bounding box (their feet) is on the inner side of the line.
Empty ZONE_LINE disables the gate (everyone is analyzed).
"""


class ZoneGate:
    def __init__(self, zone_line: str):
        self.enabled = bool(zone_line.strip())
        if self.enabled:
            x1, y1, x2, y2 = (float(v) for v in zone_line.split(","))
            self.p1 = (x1, y1)
            self.p2 = (x2, y2)

    def _side(self, px, py) -> float:
        # >0 on one side of the line, <0 on the other (2D cross product).
        (x1, y1), (x2, y2) = self.p1, self.p2
        return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)

    def inside(self, bbox) -> bool:
        if not self.enabled:
            return True
        feet_x = (bbox[0] + bbox[2]) / 2
        feet_y = bbox[3]  # bottom of the box
        # Convention: "inside" = below the line (feet_y larger). Adjust sign if
        # your restricted area is above the line.
        return self._side(feet_x, feet_y) > 0

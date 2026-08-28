"""Stage 5: visibility reasoning — the core safety property of a PPE system.

Only judge what can actually be seen. Anything not observable is reported
"not visible", NEVER "missing". A false violation costs the client's trust far
more than a missed one costs their safety record, because the first thing a
supervisor does with a noisy system is switch it off.

WHY THIS CHANGED
    The old version read 17 COCO keypoints from a YOLO-pose model (AGPL-3.0)
    and called a region visible if any of its keypoints were detected. RF-DETR
    has no pose head, so visibility is now derived from the PERSON BOX.

    That is genuinely weaker, and the code is honest about it: rather than
    pretend a box tells us as much as keypoints, the rules below are
    deliberately CONSERVATIVE — when in doubt, a region is not visible, so the
    item is "unknown" rather than a violation.

THE THREE THINGS A BOX CAN TELL US
    1. Truncation. A person box touching a frame edge is cut off there; a box
       running off the bottom means the feet are outside the image, so boots
       cannot be judged at all.
    2. Scale. Below a few dozen pixels of height, a helmet is a handful of
       pixels and the detector's own confidence is meaningless. Fine items
       (gloves) need more resolution than coarse ones (vest).
    3. Aspect. A box far wider than tall is usually a seated, bent or partly
       occluded person, where "which end is the head" stops being reliable.
"""

# Minimum person-box HEIGHT in pixels before an item is worth judging.
# Coarse, high-contrast items survive at lower resolution than small ones.
MIN_HEIGHT_PX = {
    "helmet": 60,
    "vest": 50,
    "boots": 90,     # smallest region, furthest from the camera in most mounts
    "gloves": 120,   # hands are tiny and frequently occluded by the body
}

# How far into the person box each region sits, as a fraction of box height.
# Standing adult proportions; used only to place a search region, never to
# decide presence on its own.
REGION_BANDS = {
    "head": (0.00, 0.28),
    "torso": (0.18, 0.65),
    "hands": (0.35, 0.75),
    "feet": (0.80, 1.00),
}

REGION_TO_PPE = {
    "head": "helmet",
    "torso": "vest",
    "hands": "gloves",
    "feet": "boots",
}

# A box within this many pixels of a frame edge is treated as truncated there.
EDGE_MARGIN_PX = 4

# Beyond this width/height ratio the person is not reliably upright, so
# proportional bands stop meaning what they normally mean.
MAX_ASPECT = 1.2


def region_box(person_bbox, region: str):
    """The sub-box of a person where `region` is expected to be found."""
    x1, y1, x2, y2 = person_bbox
    h = y2 - y1
    lo, hi = REGION_BANDS[region]
    return [x1, y1 + lo * h, x2, y1 + hi * h]


def visible_regions(person_bbox, frame_shape=None) -> set:
    """Which body regions are observable for this person.

    `frame_shape` is (H, W). Without it, truncation cannot be detected, so the
    caller gets the scale/aspect checks only — still conservative, just less
    informed.
    """
    x1, y1, x2, y2 = person_bbox
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        return set()

    # A non-upright box makes proportional bands meaningless.
    if w / h > MAX_ASPECT:
        return set()

    regions = set()
    for region, item in REGION_TO_PPE.items():
        if h < MIN_HEIGHT_PX.get(item, 0):
            continue
        regions.add(region)

    if frame_shape is not None:
        H, W = frame_shape[:2]
        # Cut off at the bottom of the frame -> feet are outside the image.
        if y2 >= H - EDGE_MARGIN_PX:
            regions.discard("feet")
        # Cut off at the top -> head is outside the image.
        if y1 <= EDGE_MARGIN_PX:
            regions.discard("head")
        # Cut off at either side -> hands may be outside; torso is wide enough
        # to still be judged from what remains.
        if x1 <= EDGE_MARGIN_PX or x2 >= W - EDGE_MARGIN_PX:
            regions.discard("hands")

    return regions


def expected_ppe(person_bbox, frame_shape=None) -> set:
    """The PPE items it is even possible to evaluate for this person."""
    return {REGION_TO_PPE[r] for r in visible_regions(person_bbox, frame_shape)}

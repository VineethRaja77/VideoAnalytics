"""Stage 7: body-part association.

Decide, per person, whether each expected PPE item is on THAT person's correct
body region — not merely present somewhere in the frame. A helmet on the
ground, or the vest of the worker standing behind, must not count.

WHY THIS CHANGED
    The old version anchored each item to COCO keypoints from a YOLO-pose model
    (AGPL-3.0). RF-DETR has no pose head, so items are now anchored to a
    proportional REGION OF THE PERSON BOX (see visibility.py) and matched by
    overlap.

THE RULE THAT DID NOT CHANGE, AND MUST NOT
    "Missing" requires an EXPLICIT negative detection (no_helmet / no_vest /
    no_boots) on the right region. The absence of a positive detection is
    "unknown", never a violation.

    That distinction is the whole product. Inferring "missing" from silence
    turns every small, distant or motion-blurred worker into a false alarm, and
    a supervisor who gets those switches the feature off within a week. It also
    matters more with this model than the last one: the negative classes scored
    AP 0.30 (no_helmet), 0.41 (no_vest) and 0.14 (no_boots), so a positive
    detection is far more trustworthy than its absence.
"""
from .visibility import region_box, REGION_TO_PPE

# Which body region anchors each PPE item.
PPE_REGION = {item: region for region, item in REGION_TO_PPE.items()}

# Fraction of the PPE box that must fall inside the person's region box.
# Generous, because the proportional bands are approximate — the point is to
# reject another worker's gear, not to demand pixel alignment.
MIN_OVERLAP = 0.30


def _overlap_fraction(det_box, region) -> float:
    """How much of the detection lies inside the region box, 0-1."""
    dx1, dy1, dx2, dy2 = det_box
    rx1, ry1, rx2, ry2 = region
    ix1, iy1 = max(dx1, rx1), max(dy1, ry1)
    ix2, iy2 = min(dx2, rx2), min(dy2, ry2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area = max(1e-9, (dx2 - dx1) * (dy2 - dy1))
    return inter / area


def _on_region(det, person_bbox, item) -> bool:
    region_name = PPE_REGION.get(item)
    if not region_name:
        return False
    return _overlap_fraction(det["bbox"], region_box(person_bbox, region_name)) >= MIN_OVERLAP


def assess(person, expected_items: set, ppe_detections: list,
           required_map: dict, negative_map: dict = None,
           absence_missing: set = None) -> dict:
    """
    person          : Person (bbox; keypoints are no longer used)
    expected_items  : {"helmet","vest",...} from visibility.expected_ppe
    ppe_detections  : [{class, conf, bbox}, ...] for the whole frame
    required_map    : item -> classes that PROVE it is worn
    negative_map    : item -> classes that PROVE it is absent
    absence_missing : items where no positive detection counts as MISSING.
                      LEAVE THIS EMPTY unless a class is measured to be
                      reliable — it is the setting that manufactures false
                      violations.

    Returns item -> "present" | "missing" | "unknown".
    """
    negative_map = negative_map or {}
    absence_missing = absence_missing or set()
    result = {}

    for item in expected_items:
        pos_classes = set(required_map.get(item, []))
        neg_classes = set(negative_map.get(item, []))

        # The model has no class for this item — it literally cannot judge it.
        if not pos_classes and not neg_classes:
            result[item] = "unknown"
            continue

        # Positive wins over negative: a detector that sees both a helmet and a
        # bare head on one person is more likely right about the helmet, and
        # crediting the worker is the safer error.
        if any(d["class"] in pos_classes and _on_region(d, person.bbox, item)
               for d in ppe_detections):
            result[item] = "present"
            continue

        if any(d["class"] in neg_classes and _on_region(d, person.bbox, item)
               for d in ppe_detections):
            result[item] = "missing"
            continue

        result[item] = "missing" if item in absence_missing else "unknown"

    return result

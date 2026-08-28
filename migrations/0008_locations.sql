-- 0008_locations.sql
--
-- Physical hierarchy: group -> site -> building -> floor -> zone, any depth.
--
-- Adjacency list (parent_id) + materialised path. Fixed columns per level
-- cannot express a campus with two towers and a basement car park, and every
-- new level would be another migration.
--
-- Safe to run on an existing install: adds only, and both locationId columns
-- are NULLable so nothing needs assigning before the app keeps working.

CREATE TABLE IF NOT EXISTS locations (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id varchar NOT NULL REFERENCES organizations(id),

  -- NULL = a root node for this tenant.
  -- ON DELETE RESTRICT: the application refuses to delete a node that still
  -- has children, cameras or devices. The FK is the backstop in case anything
  -- ever writes around it.
  parent_id       varchar REFERENCES locations(id) ON DELETE RESTRICT,

  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'zone',

  -- Ancestor ids, e.g. '/<rootId>/<buildingId>/'. Always starts AND ends with
  -- '/' so a prefix match cannot straddle an id boundary: LIKE '/a/b/%' can
  -- never match '/a/bc/'.
  path            text NOT NULL DEFAULT '/',
  depth           integer NOT NULL DEFAULT 0,

  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS locations_org_idx    ON locations (organization_id);
CREATE INDEX IF NOT EXISTS locations_parent_idx ON locations (parent_id);

-- The index the whole design exists for: "everything under this node" as one
-- prefix scan. text_pattern_ops makes LIKE 'prefix%' indexable regardless of
-- the database collation.
CREATE INDEX IF NOT EXISTS locations_path_idx
  ON locations (organization_id, path text_pattern_ops);

-- Attach points. NULLable: an existing install has no tree yet, and the old
-- free-text `location` / `site` / `zone` columns stay as the fallback.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS location_id varchar REFERENCES locations(id);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_id varchar REFERENCES locations(id);

CREATE INDEX IF NOT EXISTS cameras_location_idx ON cameras (location_id);
CREATE INDEX IF NOT EXISTS devices_location_idx ON devices (location_id);

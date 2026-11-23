-- NULL is untouched. An empty string records an explicit reset to automatic.
ALTER TABLE projects ADD COLUMN color text
  CHECK (color IS NULL OR (kind='project' AND (color='' OR color ~ '^#[0-9a-f]{6}$')));

-- Older computers can have relayed the field without materializing it.
UPDATE projects p SET color=c.fields->'color'->>'value'
  FROM config_items c
  WHERE c.owner_user_id=p.owner_user_id AND c.local_id=p.id::text
    AND c.kind='project' AND c.schema_version=1 AND c.unsupported=''
    AND p.kind='project' AND NOT p.config_deleted
    AND (c.fields->'color'->>'value'='' OR c.fields->'color'->>'value' ~ '^#[0-9a-f]{6}$');

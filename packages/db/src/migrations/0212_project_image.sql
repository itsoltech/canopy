-- NULL means untouched; an empty string is a versioned removal.
ALTER TABLE projects ADD COLUMN image_base64 text
  CHECK (image_base64 IS NULL OR (kind='project' AND (image_base64='' OR (
    length(image_base64) <= 24576 AND length(image_base64) % 4 = 0
    AND image_base64 ~ '^iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5[A-Za-z0-9+/]+={0,2}$'
  ))));

-- Computers on older releases can relay the field before materializing it.
UPDATE projects p SET image_base64=c.fields->'imageBase64'->>'value'
  FROM config_items c
  WHERE c.owner_user_id=p.owner_user_id AND c.local_id=p.id::text
    AND c.kind='project' AND c.schema_version=1 AND c.unsupported=''
    AND p.kind='project' AND NOT p.config_deleted
    AND jsonb_typeof(c.fields->'imageBase64'->'value')='string'
    AND (c.fields->'imageBase64'->>'value'='' OR (
      length(c.fields->'imageBase64'->>'value') <= 24576
      AND length(c.fields->'imageBase64'->>'value') % 4 = 0
      AND c.fields->'imageBase64'->>'value' ~ '^iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5[A-Za-z0-9+/]+={0,2}$'
    ));

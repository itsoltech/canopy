-- Before scoped upload receipts, some providers also recorded the image bytes in
-- the worker event itself. Only the matching item in that thread can vouch for a
-- stored preview. All evidence here survives a logical database backup and restore.
CREATE FUNCTION pg_temp.canopy_legacy_inline_previews(target_thread uuid)
RETURNS TABLE(digest text) LANGUAGE sql STABLE AS $$
WITH pending AS MATERIALIZED (
  SELECT p.thread_id, p.sha256
  FROM thread_blobs p
  WHERE p.thread_id=target_thread AND p.retained_history AND NOT p.verified
), items AS (
  SELECT e.thread_id, e.seq, e.item_id,
    coalesce(e.payload #> '{itemCompleted,item}', e.payload #> '{itemStarted,item}') AS item
  FROM thread_events e
  WHERE e.thread_id=target_thread AND e.origin='worker' AND e.kind IN ('item_started','item_completed')
    AND e.item_id IS NOT NULL
), claims AS MATERIALIZED (
  -- Keep only small keys before opening the corresponding provider envelopes.
  SELECT i.thread_id, i.seq, i.item_id, p.sha256
  FROM items i CROSS JOIN LATERAL (
    SELECT i.item #>> '{image,blob,sha256}' AS digest
    UNION ALL
    SELECT value #>> '{}' FROM jsonb_path_query(i.item, '$.toolCall.images[*].sha256') AS hashes(value)
  ) r JOIN pending p ON p.thread_id=i.thread_id AND p.sha256=r.digest
  WHERE i.item->>'itemId'=i.item_id
), codex_calls AS MATERIALIZED (
  SELECT DISTINCT c.thread_id, c.item_id, c.sha256,
    e.raw #>> '{params,threadId}' AS session_id, e.raw #>> '{params,turnId}' AS provider_turn
  FROM claims c JOIN thread_events e USING (thread_id,seq)
  WHERE e.raw->>'method'='rawResponseItem/completed'
    AND e.raw #>> '{params,item,type}' IN ('custom_tool_call_output','function_call_output')
    AND e.raw #>> '{params,item,call_id}'=c.item_id AND c.item_id<>''
    AND e.raw #>> '{params,threadId}'<>'' AND e.raw #>> '{params,turnId}'<>''
), native_calls AS MATERIALIZED (
  -- Codex sometimes journaled its native notification separately from the
  -- compacted rollout item. Index these small keys once per candidate thread.
  SELECT e.thread_id, e.seq, e.raw #>> '{params,item,call_id}' AS item_id,
    e.raw #>> '{params,threadId}' AS session_id, e.raw #>> '{params,turnId}' AS provider_turn
  FROM thread_events e
  WHERE e.thread_id=target_thread AND EXISTS (SELECT 1 FROM codex_calls)
    AND e.kind='provider_raw' AND e.origin='worker' AND e.raw->>'method'='rawResponseItem/completed'
    AND e.raw #>> '{params,item,type}' IN ('custom_tool_call_output','function_call_output')
), sources AS (
  SELECT thread_id, seq, item_id, sha256 FROM claims
  UNION ALL
  SELECT c.thread_id, n.seq, c.item_id, c.sha256
  FROM codex_calls c JOIN native_calls n USING (thread_id,session_id,provider_turn,item_id)
), envelopes AS (
  SELECT s.thread_id, s.item_id, s.sha256,
    thread_event_raw(e.raw,e.payload,e.raw_payload_refs) AS raw,
    coalesce(e.payload #>> '{itemCompleted,item,toolCall,output}',
             e.payload #>> '{itemStarted,item,toolCall,output}') AS tool_output
  FROM sources s JOIN thread_events e USING (thread_id,seq)
), blocks AS (
  SELECT e.thread_id, e.sha256, images.block
  FROM envelopes e
  CROSS JOIN LATERAL (
    -- Codex dynamic tools, MCP results and code-mode responses.
    SELECT jsonb_path_query(parts.content, '$[*]') AS block
    FROM (VALUES (e.raw #> '{params,item,contentItems}'), (e.raw #> '{params,item,result,content}'),
                 (e.raw #> '{params,item,output}')) parts(content)
    WHERE e.item_id=CASE WHEN e.raw->>'method'='rawResponseItem/completed'
      THEN e.raw #>> '{params,item,call_id}' ELSE e.raw #>> '{params,item,id}' END
    UNION ALL
    -- Claude can return several different tool results in one message.
    SELECT jsonb_path_query(e.raw,
      '$.message.content[*] ? (@.type == "tool_result" && @.tool_use_id == $id).content[*]',
      jsonb_build_object('id', e.item_id))
    WHERE e.raw->>'type'='user'
    UNION ALL
    -- Grok's native MCP response and ACP tool update.
    SELECT jsonb_path_query(e.raw, '$.result.content[*]')
    UNION ALL
    SELECT block FROM (
      SELECT jsonb_path_query(e.raw, '$.content[*] ? (@.type == "content").content') AS block
      UNION ALL
      SELECT jsonb_path_query(coalesce(g.result->'result',g.result), '$.content[*]')
      FROM (SELECT CASE
        WHEN jsonb_typeof(e.raw->'rawOutput')='object' THEN e.raw->'rawOutput'
        WHEN octet_length(e.raw->>'rawOutput')<=67108864 AND pg_input_is_valid(e.raw->>'rawOutput','jsonb')
          THEN (e.raw->>'rawOutput')::jsonb END AS result) g
    ) grok
    WHERE e.raw->>'sessionUpdate' IN ('tool_call','tool_call_update') AND e.raw->>'toolCallId'<>''
      AND right(e.item_id, length(e.raw->>'toolCallId')+1)=':' || (e.raw->>'toolCallId')
    UNION ALL
    -- The mapped MCP result may itself contain the full serialized image blocks.
    SELECT jsonb_path_query(CASE WHEN left(ltrim(e.tool_output),1)='['
      AND octet_length(e.tool_output)<=67108864 AND pg_input_is_valid(e.tool_output,'jsonb')
      THEN e.tool_output::jsonb END, '$[*]')
  ) images
), inline_images AS (
  -- Compare canonical base64 with the stored bytes. Malformed input and
  -- canopyBlob placeholders never decode or grant access.
  SELECT thread_id, sha256,
    CASE
      WHEN block->>'type'='input_image' AND jsonb_typeof(block->'image_url')='string' THEN block->>'image_url'
      WHEN block->>'type'='inputImage' AND jsonb_typeof(block->'imageUrl')='string' THEN block->>'imageUrl'
      WHEN block->>'type'='image' AND block #>> '{source,type}'='base64' AND jsonb_typeof(block #> '{source,data}')='string'
        THEN 'data:' || coalesce(block #>> '{source,media_type}','image/png') || ';base64,' || (block #>> '{source,data}')
      WHEN block->>'type'='image' AND jsonb_typeof(block->'data')='string'
        THEN 'data:' || coalesce(block->>'mimeType','image/png') || ';base64,' || (block->>'data')
    END AS data_url
  FROM blocks
)
SELECT DISTINCT i.sha256
FROM inline_images i JOIN blobs b USING (sha256)
WHERE octet_length(i.data_url) BETWEEN 1 AND 16777216 AND b.mime_type IN ('image/png','image/jpeg','image/webp','image/gif')
  AND CASE WHEN b.size_bytes BETWEEN 1 AND 8388608 AND b.size_bytes=octet_length(b.data) THEN
    translate(i.data_url, E' \t\r\n', '') =
      'data:' || b.mime_type || ';base64,' || replace(encode(b.data,'base64'), E'\n', '')
    AND encode(sha256(b.data),'hex')=b.sha256
  ELSE false END
$$;

-- Bound temporary work to one transcript at a time, including on large upgrades.
WITH scopes AS MATERIALIZED (
  SELECT DISTINCT p.thread_id FROM thread_blobs p JOIN threads t ON t.id=p.thread_id
  WHERE p.retained_history AND NOT p.verified AND t.purged_at IS NULL
)
UPDATE thread_blobs p SET verified=true
FROM scopes s CROSS JOIN LATERAL pg_temp.canopy_legacy_inline_previews(s.thread_id) proof
WHERE p.thread_id=s.thread_id AND p.sha256=proof.digest AND NOT p.verified;
DROP FUNCTION pg_temp.canopy_legacy_inline_previews(uuid);

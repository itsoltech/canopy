-- Tylko gateway wiąże kartę z konkretnym wywołaniem MCP przed pierwszym wykonaniem.
ALTER TABLE interaction_requests ADD COLUMN connector_fingerprint text;

-- Only pre-upgrade connector cards qualify for recovery. Bind one on replay after
-- comparing the saved turn, account, tool and complete, unredacted input.
UPDATE interaction_requests q SET connector_fingerprint = 'legacy'
FROM threads t, connector_accounts a
WHERE q.thread_id = t.id AND t.owner_user_id = a.owner_user_id
  AND q.request->>'connector_account_id' = a.id::text
  AND q.turn_id IS NOT NULL AND q.item_id = q.id::text
  AND q.kind = 'permission' AND q.status IN ('pending', 'allowed')
  AND q.tool_name <> '' AND jsonb_typeof(q.request->'input') = 'object'
  AND q.request->>'description' IN ('Allow this connector action?', 'Post this message in Slack?')
  AND position('[REDACTED]' in q.request::text) = 0;

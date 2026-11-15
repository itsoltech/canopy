import { DISPATCHED } from "./turn-select.ts";

export interface ComposerChoiceColumns {
  turn_id: string;
  created_at: Date | string;
  model: string;
  effort: string;
  permission_mode: string;
}

/** Correlated with the owner-scoped thread row, without reading transcript content. */
export const COMPOSER_CHOICE_SELECT = `SELECT u.id AS turn_id,u.queued_at AS created_at,
  CASE WHEN u.status='queued' AND NOT ${DISPATCHED}
    THEN coalesce(nullif(u.model,''),t.list_settings->>'model','') ELSE u.model END AS model,
  CASE WHEN u.status='queued' AND NOT ${DISPATCHED}
    THEN coalesce(nullif(u.effort,''),t.list_settings->>'effort','') ELSE u.effort END AS effort,
  coalesce(nullif(u.permission_mode,''),t.list_settings->>'permissionMode','ASK') AS permission_mode
  FROM turns u WHERE u.thread_id=t.id AND u.author_user_id=t.owner_user_id
    AND u.trigger='user' AND u.withdrawn IS NULL AND u.rewind_id IS NULL
    AND NOT (u.input ? 'shellCommand') ORDER BY u.ordinal DESC LIMIT 1`;

/** One indexed candidate per own thread, including archives; materialize only the winning metadata. */
export const LAST_USED_AGENT_SELECT = `SELECT t.id,t.provider,t.provider_profile_id,c.* FROM threads t
  CROSS JOIN LATERAL (${COMPOSER_CHOICE_SELECT}) c
  WHERE t.owner_user_id=$1::uuid AND t.deleted_at IS NULL
  ORDER BY c.created_at DESC,t.id DESC LIMIT 1`;

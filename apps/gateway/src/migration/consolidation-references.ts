import { Effect } from "effect";
import { ident, staged, type Database } from "./consolidation-catalog.ts";
import type { ConsolidationBlocker, ConsolidationInput } from "./consolidation-types.ts";

const nodeSuffix = "left(node_id,16)";

export function stageReferenceRoutes(sql: Database, input: ConsolidationInput, targetNode: string) {
  return Effect.gen(function* () {
    const owner = input.target.ownerUserId;
    const from = input.source.nodeId;

    const divergent = yield* sql<{ key: string }>`
      SELECT DISTINCT s.item_id::text AS key
      FROM pg_temp.cc_redirect_edges s JOIN public.computer_redirects d USING(kind,item_id,from_node_id)
      WHERE d.owner_user_id=${owner}::uuid AND d.home_node_id<>s.home_node_id ORDER BY key`;

    yield* sql`INSERT INTO pg_temp.cc_redirect_edges
      SELECT kind,item_id,from_node_id,home_node_id,home_name,moved_at FROM public.computer_redirects
      WHERE owner_user_id=${owner}::uuid`;

    yield* sql`CREATE TEMP TABLE cc_home_ids(
      kind text, id uuid, node_id text, PRIMARY KEY(kind,id,node_id)) ON COMMIT DROP`;
    yield* sql`INSERT INTO pg_temp.cc_home_ids
      SELECT 'thread',id,${targetNode} FROM public.threads WHERE owner_user_id=${owner}::uuid AND moved_to IS NULL
      UNION ALL SELECT 'bot',id,${targetNode} FROM public.bots WHERE owner_user_id=${owner}::uuid AND moved_to IS NULL
      UNION ALL SELECT 'thread',id,${from} FROM pg_temp.cc_threads
      UNION ALL SELECT 'bot',id,${from} FROM pg_temp.cc_bots`;

    const duplicates = yield* sql<{ key: string }>`SELECT id::text AS key
      FROM pg_temp.cc_home_ids GROUP BY kind,id HAVING count(*)>1 ORDER BY key`;

    const contradicted = yield* sql<{ key: string }>`
      SELECT DISTINCT h.id::text AS key FROM pg_temp.cc_home_ids h
      JOIN pg_temp.cc_redirect_edges e ON e.kind=h.kind AND e.item_id=h.id AND e.from_node_id=h.node_id
      WHERE h.node_id=${from} AND e.home_node_id<>h.node_id ORDER BY key`;

    yield* sql`CREATE INDEX ON pg_temp.cc_redirect_edges(kind,item_id,from_node_id)`;
    yield* sql`CREATE TEMP TABLE cc_local_thread_ids ON COMMIT DROP AS SELECT t.id,t.owner_user_id
      FROM public.threads t JOIN pg_temp.cc_redirect_edges e ON e.item_id=t.id
        AND e.kind='thread' AND e.from_node_id=${from} AND e.home_node_id=${targetNode}
      WHERE t.owner_user_id=${owner}::uuid AND t.moved_to IS NULL`;

    yield* refFunction(sql);

    const blockers: ConsolidationBlocker[] = [
      ...divergent.map(({ key }) => ({ table: "computer_redirects", key, reason: "redirect_destinations_disagree" })),
      ...duplicates.map(({ key }) => ({ table: "computer_redirects", key, reason: "two_active_homes" })),
      ...contradicted.map(({ key }) => ({ table: "computer_redirects", key, reason: "active_row_has_departure" })),
    ];

    return blockers;
  });
}

function refFunction(sql: Database) {
  return sql`CREATE FUNCTION pg_temp.cc_ref(value text, expected_kind text, origin text) RETURNS text
      LANGUAGE plpgsql STABLE STRICT AS $$
    DECLARE item uuid; current_node text; next_node text; visited text[] := ARRAY[]::text[];
    BEGIN
      IF value !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}(~[a-f0-9]{16})?$' THEN RETURN value; END IF;
      item := split_part(value,'~',1)::uuid;
      current_node := coalesce(nullif(split_part(value,'~',2),''),left(origin,16));
      LOOP
        IF current_node=ANY(visited) OR cardinality(visited)>=64 THEN RETURN value; END IF;
        visited := array_append(visited,current_node);
        IF EXISTS (SELECT FROM pg_temp.cc_home_ids h WHERE h.kind=expected_kind AND h.id=item
          AND ${sql.unsafe(nodeSuffix)}=current_node) THEN RETURN item::text; END IF;
        SELECT DISTINCT left(e.home_node_id,16) INTO next_node FROM pg_temp.cc_redirect_edges e
          WHERE e.kind=expected_kind AND e.item_id=item AND left(e.from_node_id,16)=current_node
          ORDER BY 1 LIMIT 1;
        IF next_node IS NULL THEN
          RETURN CASE WHEN cardinality(visited)>1 THEN item::text||'~'||current_node ELSE value END;
        END IF;
        current_node := next_node;
      END LOOP;
    END $$`;
}

/**
 * Event triggers name projects twice: in their scope rows and in their filter. A project merged into an existing
 * one gets the kept id in both, once (docs/bots.md, Wyzwalacze zdarzeń).
 */
function rewriteTriggerProjects(sql: Database) {
  return Effect.gen(function* () {
    const [staged] = yield* sql<{ present: boolean }>`SELECT to_regclass('pg_temp.cc_bot_trigger_scopes') IS NOT NULL
      AS present`;

    if (!staged?.present) return;
    yield* sql`UPDATE pg_temp.cc_bot_trigger_scopes s SET ref_id=m.target_id::text FROM pg_temp.cc_merge m
      WHERE m.table_name='projects' AND s.kind='project' AND s.ref_id=m.source_id::text
        AND m.target_id IS DISTINCT FROM m.source_id`;
    yield* sql`DELETE FROM pg_temp.cc_bot_trigger_scopes a USING pg_temp.cc_bot_trigger_scopes b
      WHERE a.ctid>b.ctid AND a.trigger_id=b.trigger_id AND a.kind=b.kind AND a.ref_id=b.ref_id`;
    yield* sql`UPDATE pg_temp.cc_bot_routines r SET filter=jsonb_set(r.filter,'{scope,project}',
      (SELECT coalesce(jsonb_agg(DISTINCT coalesce(m.target_id::text,p.value)),'[]') FROM
        jsonb_array_elements_text(r.filter#>'{scope,project}') p(value)
        LEFT JOIN pg_temp.cc_merge m ON m.table_name='projects' AND m.source_id::text=p.value))
      WHERE r.kind='trigger' AND jsonb_typeof(r.filter#>'{scope,project}')='array'`;
  });
}

/** Retain the federation parent relation, whose logical children may use another worker and project. */
export function rewriteStagedReferences(sql: Database, input: ConsolidationInput) {
  return Effect.gen(function* () {
    const from = input.source.nodeId;
    yield* sql`WITH refs AS MATERIALIZED (
      SELECT id,remote_parent_kind AS kind,pg_temp.cc_ref(remote_parent_ref,remote_parent_kind,${from}) AS ref
      FROM pg_temp.cc_threads WHERE remote_parent_ref IS NOT NULL AND remote_parent_kind IN ('thread','bot')
      ) UPDATE pg_temp.cc_threads d SET remote_parent_ref=r.ref,
        remote_parent_detached=NOT EXISTS (SELECT FROM pg_temp.cc_home_ids h WHERE h.kind=r.kind AND h.id::text=r.ref)
      FROM refs r WHERE d.id=r.id`;

    yield* sql`UPDATE pg_temp.cc_bot_turns
      SET remote_recipient_ref=pg_temp.cc_ref(remote_recipient_ref,'bot',${from})
      WHERE remote_recipient_ref IS NOT NULL AND position('~' IN remote_recipient_ref)>0`;

    yield* sql`UPDATE pg_temp.cc_bot_messages SET
      sender_id=pg_temp.cc_ref(sender_id,'bot',${from}),recipient_id=pg_temp.cc_ref(recipient_id,'bot',${from})
      WHERE position('~' IN sender_id)>0 OR position('~' IN recipient_id)>0`;

    yield* sql`UPDATE pg_temp.cc_schedules s
      SET new_thread=jsonb_set(s.new_thread,'{projectId}',to_jsonb(s.project_id::text))
      WHERE s.new_thread ? 'projectId'`;

    yield* sql`UPDATE pg_temp.cc_bots b SET configuration=jsonb_set(b.configuration,'{mcpServerIds}',
      (SELECT coalesce(jsonb_agg(coalesce(to_jsonb(m.target_id),ref.value) ORDER BY ref.ordinal),'[]')
       FROM jsonb_array_elements(b.configuration->'mcpServerIds') WITH ORDINALITY ref(value,ordinal)
       LEFT JOIN pg_temp.cc_merge m ON m.table_name='connector_accounts' AND m.source_id::text=ref.value#>>'{}'))
      WHERE jsonb_typeof(b.configuration->'mcpServerIds')='array'`;

    yield* rewriteTriggerProjects(sql);

    // A connector rule is an authorization for its original account. Keep the review history
    // and require a new grant if an explicit merge selected a competing account configuration.
    yield* sql`UPDATE pg_temp.cc_bot_approval_rules r SET revoked_at=coalesce(r.revoked_at,now())
      FROM pg_temp.cc_merge m WHERE r.kind='connector' AND m.table_name='connector_accounts'
        AND r.target_id=m.source_id::text`;

    yield* settingsFunction(sql);
    yield* sql`UPDATE pg_temp.cc_user_settings SET settings=pg_temp.cc_routed_pins(settings,${from})`;

    yield* sql`CREATE INDEX ON pg_temp.cc_merge(table_name,source_id)`;
    yield* sql`CREATE FUNCTION pg_temp.cc_secret_refs(value jsonb) RETURNS jsonb
      LANGUAGE plpgsql STABLE STRICT AS $$
      DECLARE rewritten jsonb; id uuid;
      BEGIN
        CASE jsonb_typeof(value)
          WHEN 'array' THEN SELECT coalesce(jsonb_agg(pg_temp.cc_secret_refs(v) ORDER BY n),'[]') INTO rewritten
            FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n);
          WHEN 'object' THEN
            SELECT coalesce(jsonb_object_agg(k,pg_temp.cc_secret_refs(v)),'{}') INTO rewritten FROM jsonb_each(value) e(k,v);
            SELECT target_id INTO id FROM pg_temp.cc_merge WHERE table_name='secrets' AND source_id::text=value->>'secretRef';
            IF id IS NOT NULL THEN rewritten := jsonb_set(rewritten,'{secretRef}',to_jsonb(id)); END IF;
          ELSE rewritten := value;
        END CASE;
        RETURN rewritten;
      END $$`;

    return yield* rewriteSecretsAndCheckScope(sql);
  });
}

function settingsFunction(sql: Database) {
  return sql`CREATE FUNCTION pg_temp.cc_routed_pins(settings jsonb, origin text) RETURNS jsonb
      LANGUAGE plpgsql STABLE STRICT AS $$
    DECLARE pin_kind text; pin_path text[]; pins jsonb;
    BEGIN
      FOREACH pin_kind IN ARRAY ARRAY['thread','bot'] LOOP
        pin_path := ARRAY['sidebar',CASE pin_kind WHEN 'thread' THEN 'pinnedThreadIds' ELSE 'pinnedBotIds' END];
        IF jsonb_typeof(settings#>pin_path) IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
        SELECT coalesce(jsonb_agg(ref ORDER BY first_position),'[]') INTO pins FROM (
          SELECT pg_temp.cc_ref(value,pin_kind,origin) AS ref,min(ordinal) AS first_position
          FROM jsonb_array_elements_text(settings#>pin_path) WITH ORDINALITY e(value,ordinal)
          GROUP BY 1) d;
        settings := jsonb_set(settings,pin_path,pins);
      END LOOP;
      RETURN settings;
    END $$`;
}

const secretFields = [
  ["provider_instances", ["api_key", "env"]],
  ["provider_instance_workers", ["overrides"]],
  ["worker_configs", ["config"]],
  ["worker_config_history", ["config"]],
  ["connector_accounts", ["legacy_headers"]],
  ["bot_mcp_servers", ["headers"]],
] as const;

function rewriteSecretsAndCheckScope(sql: Database) {
  return Effect.gen(function* () {
    const blockers: ConsolidationBlocker[] = [];

    for (const [table, fields] of secretFields) {
      for (const field of fields) {
        const col = ident(field);
        const source = staged(table);

        const missing = yield* sql.unsafe<{ key: string }>(`SELECT s.__source_key AS key FROM ${source} s
          WHERE EXISTS (SELECT FROM jsonb_path_query(s.${col},'$.**.secretRef') ref
            WHERE NOT EXISTS (SELECT FROM pg_temp.cc_secrets d WHERE d.id::text=ref#>>'{}')
              AND NOT EXISTS (SELECT FROM pg_temp.cc_merge m
                  WHERE m.table_name='secrets' AND m.source_id::text=ref#>>'{}'))
          ORDER BY key LIMIT 10`);

        blockers.push(...missing.map(({ key }) => ({ table, key, reason: "unmapped_secret_reference" })));
        yield* sql.unsafe(`UPDATE ${source} SET ${col}=pg_temp.cc_secret_refs(${col})
          WHERE jsonb_path_exists(${col},'$.**.secretRef')`);
      }
    }

    for (const spec of references) {
      const missing = yield* sql.unsafe<{ key: string }>(`SELECT s.__source_key AS key FROM ${staged(spec.table)} s
        WHERE ${spec.when} AND NOT EXISTS (SELECT FROM ${spec.from} WHERE ${spec.on}) ORDER BY key LIMIT 10`);

      blockers.push(...missing.map(({ key }) => ({ table: spec.table, key, reason: spec.reason })));
    }

    return blockers;
  });
}

const references = [
  {
    table: "schedules",
    when: "coalesce(s.new_thread->>'workspaceId','')<>''",
    from: "pg_temp.cc_project_workspaces w",
    on: "w.id::text=s.new_thread->>'workspaceId' AND w.project_id=s.project_id",
    reason: "unmapped_schedule_workspace",
  },
  {
    table: "worktree_settings",
    when: "s.project_id IS NOT NULL",
    from: "pg_temp.cc_projects p",
    on: "p.id=s.project_id",
    reason: "unmapped_worktree_settings_project",
  },
  {
    table: "worktree_settings",
    when: "s.worker_id IS NOT NULL",
    from: "pg_temp.cc_workers w",
    on: "w.id=s.worker_id",
    reason: "unmapped_worktree_settings_worker",
  },
  {
    table: "bots",
    when: "coalesce(s.configuration->>'workerId','')<>''",
    from: "pg_temp.cc_workers w",
    on: "w.id::text=s.configuration->>'workerId'",
    reason: "unmapped_bot_worker",
  },
];

export function persistConsolidationRoutes(
  sql: Database,
  input: ConsolidationInput,
  targetNode: string,
  targetName: string,
) {
  return Effect.gen(function* () {
    const owner = input.target.ownerUserId;
    const from = input.source.nodeId;
    yield* sql`WITH aliases AS (
      (SELECT DISTINCT ON(kind,item_id,from_node_id) kind,item_id,from_node_id,home_node_id,home_name,moved_at
        FROM pg_temp.cc_redirect_edges
        WHERE from_node_id<>${targetNode} AND (from_node_id=${from} OR home_node_id=${from})
        ORDER BY kind,item_id,from_node_id,moved_at DESC)
      UNION ALL SELECT kind,id,${from},${targetNode},${targetName},now()
        FROM pg_temp.cc_home_ids WHERE node_id=${from}
      ) INSERT INTO public.computer_redirects(owner_user_id,kind,item_id,from_node_id,home_node_id,home_name,moved_at,basis)
      SELECT ${owner}::uuid,kind,item_id,from_node_id,home_node_id,home_name,moved_at,'local_move' FROM aliases
      ON CONFLICT (owner_user_id,kind,item_id,from_node_id) DO NOTHING`;

    yield* sql`WITH refs AS MATERIALIZED (
      SELECT t.id,t.remote_parent_kind AS kind,pg_temp.cc_ref(t.remote_parent_ref,t.remote_parent_kind,${targetNode}) AS ref
      FROM public.threads t WHERE t.owner_user_id=${owner}::uuid AND t.moved_to IS NULL
        AND position('~' IN t.remote_parent_ref)>0
      ) UPDATE public.threads t SET remote_parent_ref=r.ref,
        remote_parent_detached=NOT EXISTS (SELECT FROM pg_temp.cc_home_ids h WHERE h.kind=r.kind AND h.id::text=r.ref)
      FROM refs r WHERE t.id=r.id AND t.remote_parent_ref IS DISTINCT FROM r.ref`;

    yield* sql`INSERT INTO public.bot_started_threads(thread_id,bot_id,use_bot_rules)
      SELECT t.id,b.id,false FROM public.threads t JOIN pg_temp.cc_home_ids b
        ON b.kind='bot' AND b.id::text=t.remote_parent_ref
      WHERE t.owner_user_id=${owner}::uuid AND t.moved_to IS NULL AND t.remote_parent_kind='bot'
        AND NOT t.remote_parent_detached ON CONFLICT(thread_id) DO NOTHING`;

    yield* sql`UPDATE public.user_settings s SET settings=pg_temp.cc_routed_pins(s.settings,${targetNode}),version=s.version+1
      WHERE s.user_id=${owner}::uuid AND s.settings IS DISTINCT FROM pg_temp.cc_routed_pins(s.settings,${targetNode})`;

    // Deleting just this origin removes cached mirrors and dependent relay routes. Other direct peers
    // stay available for a later consolidation.
    yield* sql`INSERT INTO public.computer_revocations(owner_user_id,node_id)
      VALUES(${owner}::uuid,${from}) ON CONFLICT DO NOTHING`;
    yield* sql`DELETE FROM public.computer_peers WHERE owner_user_id=${owner}::uuid AND node_id=${from}`;
    yield* sql`DELETE FROM public.config_items WHERE owner_user_id=${owner}::uuid
      AND home_node_id=${from} AND kind IN ('worker','computer')`;
  });
}

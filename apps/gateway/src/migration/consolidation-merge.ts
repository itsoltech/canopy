import { rebaseAgentMemory } from "./consolidation-memory.ts";
import { Effect } from "effect";
import {
  ident,
  keySql,
  publicTable,
  sameKey,
  staged,
  type Database,
  type SelectedTable,
} from "./consolidation-catalog.ts";
import {
  consolidationDigest,
  consolidationSecretId,
  consolidationError,
  type ConsolidationApproval,
  type ConsolidationBlocker,
  type ConsolidationConflict,
  type ConsolidationInput,
  type ConsolidationReview,
  type ConsolidationSecret,
} from "./consolidation-types.ts";

export interface MergeMatch extends ConsolidationConflict {
  targetDigest: string;
}

export function mergeConsolidation(
  sql: Database,
  input: ConsolidationInput,
  tables: readonly SelectedTable[],
  counts: Record<string, number>,
) {
  return Effect.gen(function* () {
    const blockers: ConsolidationBlocker[] = [];

    // Overlapping slugs or shared project identities keep the target ID. Compute all ID
    // maps before rewriting their incoming foreign keys.
    for (const table of tables) {
      if (table.merge && !table.matchAfterRebase && counts[table.name])
        yield* matchMerge(sql, table, input.target.ownerUserId);
    }

    const ambiguous = yield* sql<{ table: string; key: string }>`
      SELECT table_name AS "table",source_key AS key FROM pg_temp.cc_merge GROUP BY table_name,source_key HAVING count(*)>1
      UNION SELECT table_name,min(source_key) FROM pg_temp.cc_merge GROUP BY table_name,target_key HAVING count(*)>1
      ORDER BY 1,2`;

    if (ambiguous.length)
      return {
        blockers: ambiguous.map((row) => ({ ...row, reason: "ambiguous_configuration_identity" })),
        matches: [],
        secrets: [],
      };

    for (const table of tables) {
      if (counts[table.name]) blockers.push(...(yield* rewriteScope(sql, table, tables, input)));
    }

    blockers.push(...(yield* rebaseAgentMemory(sql, input)));

    for (const table of tables) {
      if (table.matchAfterRebase && counts[table.name]) yield* matchMerge(sql, table, input.target.ownerUserId);
    }

    const rows = yield* sql<{ table: string; sourceKey: string; targetKey: string; targetDigest: string }>`
      SELECT table_name AS "table",source_key AS "sourceKey",target_key AS "targetKey",target_digest AS "targetDigest"
      FROM pg_temp.cc_merge ORDER BY table_name,source_key,target_key`;

    const matches: MergeMatch[] = rows.map((value) => ({
      ...value,
      id: consolidationDigest(JSON.stringify([value.table, value.sourceKey, value.targetKey])),
    }));

    const secrets: ConsolidationSecret[] = [];

    for (const { name, secret } of tables) {
      if (!secret || !counts[name]) continue;

      const selected = yield* sql.unsafe<{ source_key: string }>(`
        SELECT __source_key AS source_key FROM ${staged(name)} WHERE __has_secret ORDER BY __source_key`);

      secrets.push(
        ...selected.map(({ source_key }) => ({
          id: consolidationSecretId(name, source_key, secret),
          table: name,
          sourceKey: source_key,
        })),
      );
    }

    return { blockers, matches, secrets };
  });
}

function matchMerge(sql: Database, table: SelectedTable, owner: string) {
  const merge = table.merge;

  if (!merge) return Effect.void;

  const sourceId = table.key.length === 1 && table.key[0] === "id" ? "s.id" : "NULL";
  const targetId = table.key.length === 1 && table.key[0] === "id" ? "d.id" : "NULL";

  // owner uses parameter $2 to keep the same parameter numbering as other target predicates.
  return sql.unsafe(
    `INSERT INTO pg_temp.cc_merge
    SELECT $1,s.__source_key,${keySql("d", table)},encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex'),
      ${sourceId},${targetId}
    FROM ${staged(table.name)} s JOIN ${publicTable(table.name)} d ON (${merge.owner}) AND (${merge.match})`,
    [table.name, owner],
  );
}

function rewriteScope(
  sql: Database,
  table: SelectedTable,
  tables: readonly SelectedTable[],
  input: ConsolidationInput,
) {
  return Effect.gen(function* () {
    const name = staged(table.name);
    const blockers: ConsolidationBlocker[] = [];

    if (table.name === "agents")
      yield* sql.unsafe(`UPDATE ${name} SET scope='private',owner_user_id=$1::uuid WHERE owner_user_id IS NULL`, [
        input.source.ownerUserId,
      ]);

    const users = new Set(table.foreignKeys.filter((key) => key.target === "users").flatMap((key) => key.columns));

    if (table.name === "thread_visuals" || table.name === "agent_memory_notes" || table.name === "thread_pull_requests")
      users.add("owner_user_id");

    for (const column of users) {
      blockers.push(...(yield* checkScope(sql, input.source.ownerUserId, table.name, column)));
      const col = ident(column);
      yield* sql.unsafe(`UPDATE ${name} SET ${col}=$1::uuid WHERE ${col}=$2::uuid`, [
        input.target.ownerUserId,
        input.source.ownerUserId,
      ]);
    }

    // Composite foreign keys can share the owner/placement column. Each source id is replaced at
    // most once per column, and moving another configuration row into its id is rejected below.
    const maps = new Map<string, string>();

    if (table.merge && table.key.length === 1 && table.key[0] === "id") maps.set("id", table.name);

    for (const key of table.foreignKeys) {
      const referenced = tables.find((candidate) => candidate.name === key.target);

      if (!referenced?.merge || referenced.key.length !== 1 || referenced.key[0] !== "id") continue;

      const column = key.columns[key.references.indexOf("id")];

      if (column !== undefined) maps.set(column, key.target);
    }

    if (table.name === "worktree_settings" || table.name === "connector_project_grants")
      maps.set("project_id", "projects");

    for (const [field, from] of maps) {
      const col = ident(field);
      yield* sql.unsafe(
        `UPDATE ${name} s SET ${col}=m.target_id FROM pg_temp.cc_merge m
        WHERE m.table_name=$1 AND m.source_id=s.${col} AND m.target_id IS DISTINCT FROM m.source_id`,
        [from],
      );
    }

    return blockers;
  });
}

export function validateApproval(review: ConsolidationReview, approval: ConsolidationApproval) {
  if (review.reviewDigest !== approval.reviewDigest)
    throw consolidationError("The approved consolidation review no longer matches the staged source and target.");

  if (review.blockers.length) throw consolidationError("The consolidation review has unresolved blockers.");

  const expected = new Set(review.conflicts.map((conflict) => conflict.id));

  if (
    Object.keys(approval.conflictChoices).length !== expected.size ||
    Object.entries(approval.conflictChoices).some(
      ([id, choice]) => !expected.has(id) || (choice !== "source" && choice !== "target"),
    )
  )
    throw consolidationError("Every configuration conflict needs an explicit source or target choice.");

  const approved = new Set(approval.approvedSecretIds);
  const possible = new Set(review.secrets.map((secret) => secret.id));

  if (approved.size !== approval.approvedSecretIds.length || [...approved].some((id) => !possible.has(id)))
    throw consolidationError("The approved secret IDs must refer to secrets in this review.");

  for (const secret of review.secrets) {
    const conflict = review.conflicts.find(
      (value) => value.table === secret.table && value.sourceKey === secret.sourceKey,
    );

    if (conflict && approval.conflictChoices[conflict.id] === "target") continue;

    if (!approved.has(secret.id))
      throw consolidationError("The selected source configuration requires explicit consent for each secret.");
  }
}

export function checkTableReferences(sql: Database, tables: readonly SelectedTable[], counts: Record<string, number>) {
  return Effect.gen(function* () {
    const blockers: ConsolidationBlocker[] = [];

    for (const table of tables) {
      const name = table.name;

      if (!counts[name]) continue;

      const collisions = yield* sql.unsafe<{ key: string }>(
        `SELECT s.__source_key AS key FROM ${staged(name)} s
        JOIN ${publicTable(name)} d ON ${sameKey("s", "d", table)}
        WHERE NOT EXISTS (SELECT 1 FROM pg_temp.cc_merge m WHERE m.table_name=$1 AND m.source_key=s.__source_key)
        ORDER BY key LIMIT 10`,
        [name],
      );

      if (name !== "blobs" && name !== "agent_memory_scopes" && name !== "connector_project_grants" && !table.sequence)
        blockers.push(...collisions.map(({ key }) => ({ table: name, key, reason: "target_row_identity_collision" })));

      for (const foreign of table.foreignKeys) {
        if (foreign.target === "users") continue;

        const on = foreign.columns
          .map((column, idx) => `s.${ident(column)}=d.${ident(foreign.references[idx] ?? "")}`)
          .join(" AND ");

        const required = foreign.columns.map((column) => `s.${ident(column)} IS NOT NULL`).join(" AND ");

        const native =
          foreign.target === "provider_instances"
            ? `AND NOT EXISTS (SELECT FROM public.provider_instances d WHERE ${on} AND d.built_in AND d.created_by IS NULL)`
            : "";

        const localThread =
          foreign.target === "threads" ? `AND NOT EXISTS (SELECT FROM pg_temp.cc_local_thread_ids d WHERE ${on})` : "";

        const rows = yield* sql.unsafe<{ key: string }>(`SELECT s.__source_key AS key FROM ${staged(name)} s
          WHERE ${required} AND NOT EXISTS (SELECT 1 FROM ${staged(foreign.target)} d WHERE ${on})
          ${native} ${localThread} ORDER BY key LIMIT 10`);

        blockers.push(...rows.map(({ key }) => ({ table: name, key, reason: "unmapped_reference:" + foreign.target })));
      }
    }

    return blockers;
  });
}

function checkScope(sql: Database, ownerUserId: string, table: string, column: string) {
  return Effect.gen(function* () {
    const col = ident(column);

    const rows = yield* sql.unsafe<{ key: string }>(
      `SELECT __source_key AS key FROM ${staged(table)}
      WHERE ${col} IS NOT NULL AND ${col}<>$1::uuid ORDER BY key LIMIT 10`,
      [ownerUserId],
    );

    return rows.map(({ key }) => ({ table, key, reason: "reference_to_another_owner:" + column }));
  });
}

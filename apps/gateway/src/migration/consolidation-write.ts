import { Effect } from "effect";
import { encryptSecret, SECRETS_KEY_ID } from "../store/secrets.ts";
import { ident, keySql, publicTable, staged, type Database, type SelectedTable } from "./consolidation-catalog.ts";
import type { MergeMatch } from "./consolidation-merge.ts";
import {
  consolidationError,
  type ApprovedConsolidationSecret,
  type ConsolidationApproval,
  type ConsolidationInput,
  type ConsolidationReview,
} from "./consolidation-types.ts";

export function writeConsolidation(
  target: Database,
  input: ConsolidationInput,
  tables: readonly SelectedTable[],
  review: ConsolidationReview,
  matches: readonly MergeMatch[],
  approval: ConsolidationApproval,
  approvedSecrets: readonly ApprovedConsolidationSecret[],
) {
  return Effect.gen(function* () {
    yield* target`CREATE TEMP TABLE cc_choices(table_name text,source_key text,choice text,
      PRIMARY KEY(table_name,source_key)) ON COMMIT DROP`;

    const decisions = matches.map(({ id, table, sourceKey }) => ({
      table_name: table,
      source_key: sourceKey,
      choice: approval.conflictChoices[id],
    }));

    yield* target`INSERT INTO pg_temp.cc_choices
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(decisions)}::jsonb) r(table_name text,source_key text,choice text)`;

    yield* storeApprovedSecrets(target, input, tables, review, matches, approval, approvedSecrets);
    yield* retireSourceLeases(target);
    yield* selectConnectorProjectGrants(target, input.target.ownerUserId);

    const populated = tables.filter(({ name }) => review.counts[name]);
    const fences = yield* suspendHistoricalAdmission(target, populated);
    yield* shiftSequences(target, populated);

    // These clocks only identify snapshots on the target installation. Newly merged notes must
    // invalidate a preexisting scope even when the source happened to have the same revision.
    yield* target`UPDATE pg_temp.cc_agent_memory_scopes SET revision=nextval('public.agent_memory_revision')`;

    for (const table of populated) yield* writeTable(target, table);

    return fences;
  });
}

/** The selected account supplies its complete access policy, even when its grant list is empty. */
function selectConnectorProjectGrants(sql: Database, owner: string) {
  return Effect.gen(function* () {
    yield* sql`DELETE FROM public.connector_project_grants g USING pg_temp.cc_merge m,pg_temp.cc_choices c
      WHERE m.table_name='connector_accounts' AND c.table_name=m.table_name AND c.source_key=m.source_key
        AND c.choice='source' AND g.account_id=m.target_id`;
    yield* sql`DELETE FROM pg_temp.cc_connector_project_grants g USING pg_temp.cc_merge m,pg_temp.cc_choices c
      WHERE m.table_name='connector_accounts' AND c.table_name=m.table_name AND c.source_key=m.source_key
        AND c.choice='target' AND g.account_id=m.target_id`;
    yield* sql`UPDATE pg_temp.cc_connector_project_grants g SET project_id=i.global_id::uuid
      FROM public.config_items i WHERE i.owner_user_id=${owner}::uuid AND i.kind='project' AND i.unsupported=''
        AND i.local_id=g.project_id::text AND i.global_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'`;
  });
}

function storeApprovedSecrets(
  target: Database,
  input: ConsolidationInput,
  tables: readonly SelectedTable[],
  review: ConsolidationReview,
  matches: readonly MergeMatch[],
  approval: ConsolidationApproval,
  approvedSecrets: readonly ApprovedConsolidationSecret[],
) {
  return Effect.gen(function* () {
    const received = new Map(approvedSecrets.map(({ id, plaintext }) => [id, plaintext]));

    const expected = review.secrets.filter((entry) => {
      const match = matches.find(({ table, sourceKey }) => table === entry.table && sourceKey === entry.sourceKey);

      return !match || approval.conflictChoices[match.id] === "source";
    });

    if (
      received.size !== approvedSecrets.length ||
      received.size !== expected.length ||
      expected.some((entry) => !received.has(entry.id))
    )
      return yield* Effect.fail(
        consolidationError("The approved secret transfer does not match the selected configuration."),
      );

    for (const entry of expected) {
      const table = tables.find(({ name }) => name === entry.table);
      const selected = received.get(entry.id);

      if (!table?.secret || selected === undefined)
        return yield* Effect.fail(consolidationError("A selected secret no longer has an import mapping."));

      const column = ident(table.secret);
      const envelope = encryptSecret(input.target.secretsKey, selected);
      const hasKeyId = table.columns.includes("key_id");
      const setKeyId = hasKeyId ? ",key_id=$3" : "";
      const values = hasKeyId ? [envelope, entry.sourceKey, SECRETS_KEY_ID] : [envelope, entry.sourceKey];
      yield* target.unsafe(
        `UPDATE ${staged(table.name)} SET ${column}=$1::bytea${setKeyId}
        WHERE __source_key=$2`,
        values,
      );
      received.delete(entry.id);
    }
  });
}

function retireSourceLeases(sql: Database) {
  return Effect.gen(function* () {
    yield* sql`UPDATE pg_temp.cc_schedules SET lease_owner=NULL,lease_until=NULL`;
    yield* sql`UPDATE pg_temp.cc_turns SET lease_owner=NULL,lease_until=NULL`;
    yield* sql`UPDATE pg_temp.cc_bot_turns SET lease_token=NULL,lease_until=NULL`;
    yield* sql`UPDATE pg_temp.cc_worker_configs SET applied_at=NULL,applied_version=NULL,applied_ok=NULL,apply_report=NULL`;
    yield* sql`UPDATE pg_temp.cc_connector_accounts SET slack_refresh_attempt=NULL,slack_refresh_started_at=NULL`;
    yield* sql`UPDATE pg_temp.cc_github_accounts SET refresh_lease=NULL,refresh_lease_until=NULL`;
    yield* sql`UPDATE pg_temp.cc_messenger_accounts SET lease_holder=NULL,lease_token=NULL,lease_until=NULL,
      refresh_attempt=NULL,refresh_started_at=NULL`;
    yield* sql`UPDATE pg_temp.cc_messenger_outbound SET lease_token=NULL`;
    yield* sql`UPDATE pg_temp.cc_thread_secrets SET applied_revision=0,file_path=NULL`;
  });
}

const historicalTriggers = new Map<string, readonly string[]>(
  Object.entries({
    threads: [
      "threads_00_rewind_fork_point",
      "threads_before_insert",
      "threads_before_update",
      "threads_require_visible_parent",
      "threads_worktree_placement",
      "worktree_available_thread",
      "require_available_thread_branch",
    ],
    turns: ["turns_require_visible", "turns_rewind_admission", "worktree_available_turn", "turns_import_gate"],
    schedules: ["schedules_require_visible", "schedules_rewind_admission"],
    goals: ["worktree_available_goal", "goals_rewind_admission"],
    worker_configs: ["worker_configs_history"],
  }),
);

interface AdmissionChanges {
  triggers: { table: string; name: string }[];
  foreign: { table: string; name: string }[];
}

function suspendHistoricalAdmission(sql: Database, tables: readonly SelectedTable[]) {
  return Effect.gen(function* () {
    const changes: AdmissionChanges = { triggers: [], foreign: [] };
    const order = new Map(tables.map(({ name }, idx) => [name, idx]));

    // Already-terminal history bypasses only the named live admission gates. Constraints and
    // derived sidebar/transcript projections still run. Transactional DDL reverts on rollback.
    for (const table of tables) {
      for (const name of historicalTriggers.get(table.name) ?? []) changes.triggers.push({ table: table.name, name });

      for (const key of table.foreignKeys) {
        const from = order.get(table.name) ?? 0;
        const to = order.get(key.target) ?? -1;

        if (to > from && !key.deferrable) changes.foreign.push({ table: table.name, name: key.name });
      }
    }

    // Previously imported or existing threads can acquire a resolved qualified reference too.
    if (!order.has("threads")) changes.triggers.push({ table: "threads", name: "threads_before_update" });

    for (const { table, name } of changes.triggers) {
      const [trigger] = yield* sql<{ enabled: string }>`
        SELECT t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname=${table} AND t.tgname=${name} AND NOT t.tgisinternal`;

      if (trigger?.enabled !== "O")
        return yield* Effect.fail(consolidationError("A historical import trigger differs from the supported schema."));
      yield* sql.unsafe(`ALTER TABLE ${publicTable(table)} DISABLE TRIGGER ${ident(name)}`);
    }

    for (const { table, name } of changes.foreign)
      yield* sql.unsafe(
        `ALTER TABLE ${publicTable(table)} ALTER CONSTRAINT ${ident(name)} DEFERRABLE INITIALLY DEFERRED`,
      );

    yield* sql`SET CONSTRAINTS ALL DEFERRED`;

    return changes;
  });
}

export function restoreHistoricalAdmission(sql: Database, changes: AdmissionChanges) {
  return Effect.gen(function* () {
    // The new rows must satisfy every original FK before the transaction can become visible.
    yield* sql`SET CONSTRAINTS ALL IMMEDIATE`;

    for (const { table, name } of changes.foreign)
      yield* sql.unsafe(`ALTER TABLE ${publicTable(table)} ALTER CONSTRAINT ${ident(name)} NOT DEFERRABLE`);

    for (const { table, name } of changes.triggers)
      yield* sql.unsafe(`ALTER TABLE ${publicTable(table)} ENABLE TRIGGER ${ident(name)}`);
  });
}

function shiftSequences(sql: Database, populated: readonly SelectedTable[]) {
  return Effect.gen(function* () {
    for (const { name, sequence } of populated) {
      if (!sequence) continue;

      const field = ident(sequence);
      const target = publicTable(name);
      const stage = staged(name);
      yield* sql.unsafe(
        `CREATE TEMP TABLE ${ident("cc_sequence_" + name)} ON COMMIT DROP AS
        SELECT __source_key,${field} AS old_seq,nextval(pg_get_serial_sequence($1,$2)) AS new_seq
        FROM (SELECT __source_key,${field} FROM ${stage} ORDER BY ${field}) s`,
        [target, sequence],
      );

      const mapping = staged("sequence_" + name);
      yield* sql.unsafe(
        `UPDATE ${stage} s SET ${field}=m.new_seq FROM ${mapping} m WHERE s.__source_key=m.__source_key`,
      );

      if (name === "bot_messages")
        yield* sql`UPDATE pg_temp.cc_bots b SET last_read_seq=coalesce((
          SELECT max(m.new_seq) FROM pg_temp.cc_sequence_bot_messages m
          JOIN pg_temp.cc_bot_messages s USING(__source_key) WHERE s.bot_id=b.id AND m.old_seq<=b.last_read_seq),0)`;
    }
  });
}

const insertConflicts = new Map([
  ["blobs", "ON CONFLICT (sha256) DO NOTHING"],
  ["connector_project_grants", "ON CONFLICT (account_id,project_id) DO NOTHING"],
  ["agent_memory_scopes", "ON CONFLICT (owner_user_id,scope_key) DO UPDATE SET revision=excluded.revision"],
]);

function writeTable(sql: Database, table: SelectedTable) {
  return Effect.gen(function* () {
    const { name, merge, written } = table;
    const target = publicTable(name);
    const stage = staged(name);

    const conflict = insertConflicts.get(name) ?? "";
    const cols = written.map(ident).join(",");
    const select = written.map((field) => "s." + ident(field)).join(",");

    if (merge)
      yield* sql
        .unsafe(
          `UPDATE ${target} d
        SET ${merge.update.map((field) => `${ident(field)}=s.${ident(field)}`).join(",")}
        FROM ${stage} s JOIN pg_temp.cc_choices c ON c.table_name=$1 AND c.source_key=s.__source_key
        JOIN pg_temp.cc_merge m ON m.table_name=c.table_name AND m.source_key=c.source_key
        WHERE c.choice='source' AND ${keySql("d", table)}=m.target_key`,
          [name],
        )
        .pipe(
          Effect.mapError(() => consolidationError(`Could not apply an approved configuration choice in ${name}.`)),
        );

    yield* sql
      .unsafe(
        `INSERT INTO ${target} (${cols}) OVERRIDING SYSTEM VALUE
      SELECT ${select} FROM ${stage} s WHERE NOT EXISTS (
        SELECT FROM pg_temp.cc_choices c WHERE c.table_name=$1 AND c.source_key=s.__source_key)
      ${conflict}`,
        [name],
      )
      .pipe(Effect.mapError(() => consolidationError(`Could not import ${name}. The transaction was rolled back.`)));
  });
}

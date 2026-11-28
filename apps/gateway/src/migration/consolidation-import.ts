import { Cause, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import {
  checkProjectedSchema,
  consolidationCatalog,
  databaseLayer,
  staged,
  type Database,
  type SelectedTable,
} from "./consolidation-catalog.ts";
import { checkTableReferences, mergeConsolidation, validateApproval } from "./consolidation-merge.ts";
import {
  persistConsolidationRoutes,
  rewriteStagedReferences,
  stageReferenceRoutes,
} from "./consolidation-references.ts";
import { inspectIdentity, stageConsolidation, verifyProjectionIdentity } from "./consolidation-stage.ts";
import {
  consolidationApprovalDigest,
  consolidationContext,
  consolidationDigest,
  consolidationError,
  validateConsolidation,
  type ApprovedConsolidationSecret,
  type ConsolidationApproval,
  type ConsolidationBlocker,
  type ConsolidationInput,
  type ConsolidationReceipt,
  type ConsolidationReview,
} from "./consolidation-types.ts";
import { restoreHistoricalAdmission, writeConsolidation } from "./consolidation-write.ts";
import { DatabaseMigrationError } from "./postgres-tools.ts";

export { consolidationSecretId } from "./consolidation-types.ts";

export type {
  ApprovedConsolidationSecret,
  ConsolidationApproval,
  ConsolidationInput,
  ConsolidationReceipt,
  ConsolidationReview,
} from "./consolidation-types.ts";

export function inspectConsolidation(input: ConsolidationInput): Promise<ConsolidationReview> {
  validateConsolidation(input);

  return runTarget(input, (target) =>
    withStagedSource(input, target, (stagedSource) => stagedSource.pipe(Effect.map(({ review }) => review))),
  );
}

export function importConsolidation(
  input: ConsolidationInput,
  approval: ConsolidationApproval,
  approvedSecrets: readonly ApprovedConsolidationSecret[],
): Promise<ConsolidationReceipt> {
  validateConsolidation(input);

  return runTarget(
    input,
    (target) =>
      Effect.gen(function* () {
        const existing = yield* findReceipt(target, input, input.source.nodeId);

        if (existing) {
          if (
            existing.operationId !== input.operationId ||
            existing.sourceNodeId !== input.source.nodeId ||
            existing.sourceOwnerUserId !== input.source.ownerUserId ||
            existing.targetOwnerUserId !== input.target.ownerUserId ||
            existing.archiveSha256 !== input.archiveSha256 ||
            existing.reviewDigest !== approval.reviewDigest ||
            existing.approvalDigest !== consolidationApprovalDigest(approval)
          )
            return yield* Effect.fail(
              consolidationError("This operation or source already has a different consolidation receipt."),
            );

          return receipt(existing, true);
        }

        yield* targetOffline(target, input.operationId);

        return yield* withStagedSource(
          input,
          target,
          (stagedSource) =>
            Effect.gen(function* () {
              const { tables, review, matches, targetIdentity } = yield* stagedSource;

              yield* Effect.try({
                try: () => validateApproval(review, approval),
                catch: (error) =>
                  error instanceof DatabaseMigrationError
                    ? error
                    : consolidationError("The consolidation approval is invalid."),
              });

              const changes = yield* writeConsolidation(
                target,
                input,
                tables,
                review,
                matches,
                approval,
                approvedSecrets,
              );

              yield* persistConsolidationRoutes(target, input, targetIdentity.node_id, targetIdentity.name);
              yield* restoreHistoricalAdmission(target, changes);
              yield* saveReceipt(target, input, review, approval, tables);

              return {
                ...consolidationContext(input),
                reviewDigest: review.reviewDigest,
                counts: review.counts,
                alreadyApplied: false,
              };
            }),
          true,
        );
      }),
    true,
  );
}

type RecoveryInput = Pick<ConsolidationInput, "operationId" | "targetDatabaseUrl"> & {
  target: { ownerUserId: string };
};

/** Resolve an ambiguous commit without connecting to the staged source or presenting its keys. */
export function readConsolidationReceipt(input: RecoveryInput): Promise<ConsolidationReceipt | null> {
  return runTarget(input, (target) =>
    Effect.map(findReceipt(target, input), (row) => (row ? receipt(row, true) : null)),
  );
}

function prepareConsolidation(input: ConsolidationInput, target: Database, source: Database, apply: boolean) {
  return Effect.gen(function* () {
    yield* source`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const { selected: tables } = yield* consolidationCatalog(target);
    yield* checkProjectedSchema(source, tables);
    yield* verifyProjectionIdentity(source, input, apply);

    const targetIdentity = yield* inspectIdentity(target, input.target.ownerUserId, input.target.secretsKey);

    if (targetIdentity.node_id.slice(0, 16) === input.source.nodeId.slice(0, 16))
      return yield* Effect.fail(
        consolidationError("The staged source cannot share the target's linked computer identity."),
      );

    const { counts, blockers } = yield* stageConsolidation(source, target, input, tables);
    const merged = yield* mergeConsolidation(target, input, tables, counts);
    const routes = yield* stageReferenceRoutes(target, input, targetIdentity.node_id);
    const references = yield* rewriteStagedReferences(target, input);
    const structural = yield* checkTableReferences(target, tables, counts);
    const portability = yield* checkPortability(target, input);

    const unresolved = [...blockers, ...merged.blockers, ...routes, ...references, ...structural, ...portability].sort(
      (left, right) =>
        left.table.localeCompare(right.table) ||
        left.key.localeCompare(right.key) ||
        left.reason.localeCompare(right.reason),
    );

    const conflicts = merged.matches.map(({ id, table, sourceKey, targetKey }) => ({
      id,
      table,
      sourceKey,
      targetKey,
    }));

    const metadata = {
      ...consolidationContext(input),
      counts,
      conflicts,
      secrets: merged.secrets,
      blockers: unresolved,
    };

    const review: ConsolidationReview = {
      ...metadata,
      reviewDigest: consolidationDigest(
        JSON.stringify({
          metadata,
          targetNode: targetIdentity.node_id,
          targetConfig: merged.matches.map(({ targetDigest }) => targetDigest),
        }),
      ),
    };

    return { tables, review, matches: merged.matches, targetIdentity };
  });
}

function withStagedSource<A, E>(
  input: ConsolidationInput,
  target: Database,
  use: (prepared: ReturnType<typeof prepareConsolidation>) => Effect.Effect<A, E>,
  apply = false,
) {
  // Both SQL client instances retain separate transaction services. The projection is read
  // in a single stable snapshot while the target stages and maps its rows.
  return Effect.gen(function* () {
    const source = yield* SqlClient.SqlClient;

    return yield* source.withTransaction(use(prepareConsolidation(input, target, source, apply)));
  }).pipe(Effect.provide(databaseLayer(input.sourceDatabaseUrl, "canopy-consolidation-source")));
}

async function runTarget<A, E>(
  input: RecoveryInput,
  run: (target: Database) => Effect.Effect<A, E>,
  exclusive = false,
): Promise<A> {
  const outcome = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!exclusive) yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
          yield* sql`SET LOCAL lock_timeout='5s'`;

          if (exclusive) {
            yield* sql`SET LOCAL synchronous_commit='on'`;
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.gateway_relocation.operator',0))`;
          }

          return yield* run(sql);
        }),
      );
    }).pipe(Effect.provide(databaseLayer(input.targetDatabaseUrl, "canopy-consolidation-target"))),
  );

  if (Exit.isSuccess(outcome)) return outcome.value;

  // SQL and driver errors may include archive identifiers, ciphertext, or connection strings.
  for (const item of outcome.cause.reasons)
    if (Cause.isFailReason(item) && item.error instanceof DatabaseMigrationError) throw item.error;

  throw consolidationError(
    "Consolidation could not be completed. Check the isolated database, schema, and operator privileges.",
  );
}

function targetOffline(sql: Database, operationId: string) {
  return Effect.gen(function* () {
    const [state] = yield* sql<{ quiet: boolean; fenced: boolean }>`SELECT NOT EXISTS (
      SELECT FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()
    ) AND NOT EXISTS (SELECT FROM pg_prepared_xacts WHERE database=current_database())
      AND pg_try_advisory_xact_lock(hashtextextended('canopy.gateway_relocation.runtime',0)) AS quiet,
      EXISTS (SELECT FROM public.gateway_relocation_fence WHERE singleton AND state='drained'
        AND operation_id=${operationId}::uuid) AS fenced`;

    if (!state?.quiet || !state.fenced)
      return yield* Effect.fail(
        consolidationError("The target gateway must be stopped with the matching drained fence and no other sessions."),
      );
  });
}

interface StoredReceipt extends Omit<ConsolidationReceipt, "alreadyApplied"> {
  approvalDigest: string;
}

function findReceipt(sql: Database, input: RecoveryInput, sourceNodeId?: string) {
  return Effect.map(
    sql<StoredReceipt>`SELECT operation_id AS "operationId", source_node_id AS "sourceNodeId",
    source_owner_user_id AS "sourceOwnerUserId",target_owner_user_id AS "targetOwnerUserId", archive_sha256 AS "archiveSha256",
    review_digest AS "reviewDigest",approval_digest AS "approvalDigest",counts FROM public.gateway_consolidation_receipts
    WHERE target_owner_user_id=${input.target.ownerUserId}::uuid
      AND (operation_id=${input.operationId}::uuid OR source_node_id=${sourceNodeId ?? null})
    ORDER BY (operation_id=${input.operationId}::uuid) DESC LIMIT 1`,
    ([found]) => found,
  );
}

function receipt(row: StoredReceipt, alreadyApplied: boolean): ConsolidationReceipt {
  const { operationId, sourceNodeId, sourceOwnerUserId, targetOwnerUserId, archiveSha256, reviewDigest, counts } = row;

  return {
    operationId,
    sourceNodeId,
    sourceOwnerUserId,
    targetOwnerUserId,
    archiveSha256,
    reviewDigest,
    counts,
    alreadyApplied,
  };
}

function saveReceipt(
  sql: Database,
  input: ConsolidationInput,
  review: ConsolidationReview,
  approval: ConsolidationApproval,
  tables: readonly SelectedTable[],
) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO public.gateway_consolidation_receipts(operation_id,source_node_id,source_owner_user_id,
      target_owner_user_id,archive_sha256,review_digest,approval_digest,counts) VALUES (
        ${input.operationId}::uuid,${input.source.nodeId},${input.source.ownerUserId}::uuid,${input.target.ownerUserId}::uuid,
        ${input.archiveSha256},${review.reviewDigest},${consolidationApprovalDigest(approval)},${JSON.stringify(review.counts)}::jsonb)`;

    for (const { name, idKind } of tables) {
      if (!idKind || !review.counts[name]) continue;

      yield* sql.unsafe(
        `INSERT INTO public.gateway_consolidation_ids(operation_id,kind,source_id,target_id)
        SELECT $1::uuid,$2,(__source_key::jsonb->>0)::uuid,id FROM ${staged(name)}`,
        [input.operationId, idKind],
      );
    }
  });
}

function checkPortability(sql: Database, input: ConsolidationInput) {
  return sql<ConsolidationBlocker>`
    SELECT 'blobs' AS "table", s.sha256 AS key,'attachment_content_unavailable' AS reason FROM pg_temp.cc_blobs s
      LEFT JOIN public.blobs d USING(sha256)
      WHERE (s.data IS NULL OR encode(sha256(s.data),'hex')<>s.sha256 OR octet_length(s.data)<>s.size_bytes)
        OR (d.sha256 IS NOT NULL AND (d.data IS NULL OR encode(sha256(d.data),'hex')<>d.sha256 OR d.size_bytes<>s.size_bytes))
    UNION ALL SELECT 'workers',s.id::text,'target_worker_credential_collision' FROM pg_temp.cc_workers s
      JOIN public.workers d USING(credential_hash) WHERE d.id<>s.id
    UNION ALL SELECT 'import_runs',s.id::text,'active_work' FROM pg_temp.cc_import_runs s WHERE s.status IN ('running','paused')
    UNION ALL SELECT 'worktrees',s.id::text,'active_work' FROM pg_temp.cc_worktrees s WHERE s.removal_started_at IS NOT NULL
    UNION ALL SELECT 'connector_executions',s.id::text,'active_work' FROM pg_temp.cc_connector_executions s
      WHERE s.finished_at IS NULL
    UNION ALL SELECT 'threads',s.__source_key,'target_creation_request_collision' FROM pg_temp.cc_threads s
      JOIN public.threads d ON d.owner_user_id=${input.target.ownerUserId}::uuid AND d.creation_request_id=s.creation_request_id
      WHERE d.id<>s.id
    UNION ALL SELECT 'bots',s.__source_key,'target_creation_request_collision' FROM pg_temp.cc_bots s
      JOIN public.bots d ON d.owner_user_id=${input.target.ownerUserId}::uuid AND d.client_request_id=s.client_request_id
      WHERE d.id<>s.id
    UNION ALL SELECT 'projects',s.__source_key,'target_project_slug_collision'
      FROM pg_temp.cc_projects s JOIN public.projects d ON d.owner_user_id=s.owner_user_id AND d.slug=s.slug
      WHERE s.archived_at IS NULL AND d.archived_at IS NULL AND s.id<>d.id
        AND NOT EXISTS (SELECT FROM pg_temp.cc_merge m WHERE m.table_name='projects' AND m.source_key=s.__source_key)
    UNION ALL SELECT 'connector_accounts',s.__source_key,'local_github_agent_binding'
      FROM pg_temp.cc_connector_accounts s WHERE s.connector_type='github_repository' OR EXISTS (
        SELECT FROM public.connector_accounts d WHERE d.id=s.id AND d.connector_type='github_repository')
    UNION ALL SELECT 'connector_accounts',s.__source_key,'target_connector_namespace_collision'
      FROM pg_temp.cc_connector_accounts s JOIN public.connector_accounts d USING(namespace) WHERE d.id<>s.id
    UNION ALL SELECT 'github_accounts',s.__source_key,'target_github_identity_collision'
      FROM pg_temp.cc_github_accounts s JOIN public.github_accounts d USING(owner_user_id,host,github_user_id) WHERE d.id<>s.id
    UNION ALL SELECT 'github_pull_requests',s.__source_key,'target_pull_request_identity_collision'
      FROM pg_temp.cc_github_pull_requests s JOIN public.github_pull_requests d USING(owner_user_id,host,repository_id,number)
      WHERE d.id<>s.id
    UNION ALL SELECT 'messenger_accounts',s.__source_key,'target_messenger_workspace_collision'
      FROM pg_temp.cc_messenger_accounts s JOIN public.messenger_accounts d USING(owner_user_id,provider,external_id)
      WHERE s.deleted_at IS NULL AND d.deleted_at IS NULL AND s.id<>d.id
    UNION ALL SELECT 'messenger_accounts',s.__source_key,'target_messenger_connector_collision'
      FROM pg_temp.cc_messenger_accounts s JOIN public.messenger_accounts d USING(connector_account_id)
      WHERE s.deleted_at IS NULL AND d.deleted_at IS NULL AND s.id<>d.id
    ORDER BY 1,2,3`;
}

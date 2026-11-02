import { createHash } from "node:crypto";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CommandSchema,
  ConfigAppliedSchema,
  InteractionKind,
  ItemSchema,
  PermissionMode,
  Provider,
  ThreadEventSchema,
  ThreadSpecSchema,
  UsageSchema,
  WorkerConfigSchema,
  ui,
  type Command,
  type ConfigApplied,
  type Hello,
  type InteractionRequest,
  type Item,
  type ThreadSpec,
  type WorkerConfig,
} from "@open-agents/contracts";
import { Context, Effect, Layer, Result } from "effect";
import { decodeUserAnswers, type UserQuestion } from "@open-agents/domain";
import { writeInteractionTimeline } from "./interaction-timeline.ts";
import { SqlClient, type SqlError } from "effect/sql";
import { isAbsolutePath, isWithinWorkspace, normalizePath, pathKey, pathStyle, scratchBase, scratchCwd } from "./paths.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";
import { toUiAttachment, type StoredAttachment } from "./attachments.ts";
import { toUiQuote, type StoredQuote } from "./quotes.ts";
import { mentionsFromJson, type StoredMentions } from "../core/mentions.ts";
import { threadLifecycle, type ThreadLifecycle } from "./thread-lifecycle.ts";
import { archivedPage } from "./archived-pagination.ts";
import { threadSecretsStore, type ThreadSecretsStore } from "./thread-secrets.ts";
import { connectorStore } from "../connectors/store.ts";

/**
 * Gateway data access (PostgreSQL). One service, grouped by concern; every query casts uuid
 * parameters explicitly because the driver sends strings as text.
 */

export class NotFound extends Error {
  override readonly name = "NotFound";
}
export class Invalid extends Error {
  override readonly name = "Invalid";
}

type Sql = SqlError.SqlError;
type Fx<A> = Effect.Effect<A, Sql | NotFound | Invalid>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ThreadRow {
  project_kind?: string;
  id: string;
  project_id: string;
  owner_user_id: string;
  kind: "main" | "side";
  parent_thread_id: string | null;
  root_thread_id: string;
  depth: number;
  origin: string;
  schedule_id?: string | null;
  schedule_name?: string;
  schedule_run?: number | null;
  interaction_route: "human" | "parent";
  agent_id: string | null;
  runtime: string;
  provider: string;
  provider_profile_id: string | null;
  worker_id: string | null;
  workspace_id: string | null;
  cwd: string | null;
  provider_thread_id: string | null;
  fork_source_thread_id: string | null;
  fork_after_turn_id: string | null;
  /** Joined: the fork point's number in the thread it belongs to (fork_source_thread_id). */
  fork_after_turn_ordinal?: number | null;
  settings: { model?: string; effort?: string; permissionMode?: string; instructions?: string };
  status: string;
  status_detail: string | null;
  title: string;
  title_source: "provisional" | "generated" | "user";
  title_revision: bigint;
  title_requested: boolean;
  title_context: string;
  last_seq: bigint;
  created_at: Date;
  archived_at?: Date | null;
  archived_by?: string | null;
  archived_by_thread_id?: string | null;
  archived_by_thread_title?: string | null;
  deleted_at?: Date | null;
  marked_unread?: boolean;
  pending_interactions?: bigint | number;
  last_activity_at?: Date | null;
  /** Joined: status of the open goal, running background tasks. */
  goal_status?: string | null;
  background_tasks?: bigint | number;
  /** Joined for side threads: the start of the last agent message (a subagent's result). */
  last_message?: string | null;
  unseen_result?: string | null;
  /** Joined: how the latest ended turn ended. */
  last_turn_status?: string | null;
}

/** Characters of a side thread's last message in ui.Thread (the subagent card in the parent's timeline). */
const LAST_MESSAGE_PREVIEW = 600;

export interface TurnRow {
  id: string;
  /** The bot that started or sent the turn (trigger bot), when the query joins it. */
  bot_id?: string | null;
  thread_id: string;
  ordinal: number;
  status: string;
  trigger: string;
  /**
   * text = what the model got; note + message = the same split for the UI (platform-queued turns, a message with
   * attachments or quotes: the note lists them); attachments = the files of the message, with their paths on the
   * worker; quotes = the passages of the thread it quotes (shown to the model in the note).
   */
  input: { text?: string; note?: string; message?: string; attachments?: StoredAttachment[]; quotes?: StoredQuote[] } & StoredMentions;
  /** The message's override while queued; the values sent to the worker once started ('' = default). */
  model?: string;
  effort?: string;
  /** Same as model: the override ('' = the thread's default), then the mode sent (PermissionMode enum name). */
  permission_mode?: string;
  error: string | null;
  /** failed: platform | harness; interrupted: user | system (docs/durability.md, "Stany tury i wątku"). */
  error_source?: string | null;
  error_code?: string | null;
  interrupt_reason?: string | null;
  interrupt_source?: string | null;
  provider_turn_ref: string | null;
  queued_at: Date;
  started_at?: Date | null;
  completed_at?: Date | null;
  usage?: JsonValue | null;
  hops?: number;
  schedule_id?: string | null;
  agent_call_id?: string | null;
  interaction_request_id?: string | null;
  goal_id?: string | null;
  /** Joined from turn_sources (with the sender's thread: SenderColumns). */
  source_kind?: string | null;
  source_thread_id?: string | null;
  source_title?: string | null;
  source_provider?: string | null;
  source_profile_id?: string | null;
  source_model?: string | null;
  source_project_id?: string | null;
  source_worker_id?: string | null;
  source_status?: string | null;
  question_kind?: string | null;
  question_tool?: string | null;
  /** Joined from turn_sources: a background_task turn's tasks (item ids). */
  background_item_ids?: string[] | null;
  /** Taken out of the queue by the user (cancelled): deleted | steered (docs/ui-api.md, "Kolejka"). */
  withdrawn?: string | null;
  /** Grows with every edit of the queued input. */
  revision?: number;
}

export interface OutboxRow {
  id: string;
  worker_id: string;
  thread_id: string | null;
  turn_id: string | null;
  kind: string;
  payload: Uint8Array;
}

export class GatewayStore extends Context.Service<
  GatewayStore,
  ThreadSecretsStore & {
    connectors: ReturnType<typeof connectorStore>;
    // users
    ensureUser(email: string, displayName: string): Fx<string>;
    // workers
    authenticateWorker(credential: string): Fx<string | undefined>;
    addWorker(input: { name: string; ownerUserId: string }): Fx<{ workerId: string; credential: string }>;
    workerConnected(workerId: string, instanceId: string, hello: Hello): Fx<void>;
    workerSeen(workerId: string): Fx<void>;
    journalCursors(workerId: string, journalId: string): Fx<{ threadId: string; lastSeq: bigint }[]>;
    /**
     * Stores a new config version. Profile API keys are never stored inline: pass them as secret ids
     * (secretRefs: profile id -> secrets.id); they are resolved when the config is sent to the worker.
     */
    setWorkerConfig(
      workerId: string,
      config: MessageInitShape<typeof WorkerConfigSchema>,
      updatedBy: string,
      secretRefs?: Readonly<Record<string, string>>,
    ): Fx<bigint>;
    putSecret(input: { ownerUserId: string | null; name: string; plaintext: string; createdBy: string }): Fx<string>;
    workerConfig(workerId: string): Fx<WorkerConfig | undefined>;
    configApplied(workerId: string, report: ConfigApplied): Fx<void>;
    listWorkers(online: ReadonlySet<string>, ownerUserId?: string): Fx<ui.Worker[]>;
    // projects
    createProject(ownerUserId: string, name: string): Fx<ui.Project>;
    lockProject(ownerUserId: string, projectId: string): Fx<void>;
    renameProject(ownerUserId: string, projectId: string, name: string): Fx<void>;
    archiveProject(ownerUserId: string, projectId: string): Fx<void>;
    createWorkspace(input: { projectId: string; workerId: string; rootPath: string; label: string }): Fx<ui.Workspace>;
    /** Another directory (same worker) or label; unset = unchanged. Threads keep their own directory. */
    updateWorkspace(ownerUserId: string, input: { workspaceId: string; rootPath?: string | undefined; label?: string | undefined }): Fx<ui.Workspace>;
    /** Takes the project off the workspace's worker (archived): no new threads there, existing ones go on. */
    removeWorkspace(ownerUserId: string, workspaceId: string): Fx<ui.Workspace>;
    listProjects(ownerUserId: string): Fx<ui.Project[]>;
    // threads and turns
    createThread(ownerUserId: string, request: ui.CreateThreadRequest): Fx<ThreadRow>;
    thread(threadId: string, includeDeleted?: boolean): Fx<ThreadRow>;
    /** The owner saw the thread up to `upToSeq` (capped at its last event; the marker only grows). False when nothing changed. */
    markThreadSeen(ownerUserId: string, threadId: string, upToSeq: bigint): Fx<boolean>;
    /** Threads of a project, or of every project the user owns when projectId is empty. */
    listThreads(ownerUserId: string, projectId: string, includeArchived?: boolean, sidebarOnly?: boolean): Fx<ReadonlyArray<ThreadRow>>;
    listArchivedThreads(ownerUserId: string, request: ui.ListArchivedThreadsRequest): Fx<{ threads: ThreadRow[]; sideThreads: ThreadRow[]; totalCount: number; nextPageToken: string }>;
    threadSpec(row: ThreadRow): ThreadSpec;
    setThreadStatus(threadId: string, status: string, detail: string | null): Fx<void>;
    /**
     * A user's message as the next turn. With attachments: `input` is the prepared input (note + message) and the
     * attachments are bound to the turn in the same transaction (each only once).
     */
    enqueueTurn(input: {
      threadId: string;
      text: string;
      userId: string;
      clientRequestId: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
      input?: TurnRow["input"];
    }): Fx<TurnRow>;
    /** A user turn with this client request id, if any (SendMessage idempotency across queue and steer). */
    turnByClientRequest(threadId: string, clientRequestId: string): Fx<TurnRow | undefined>;
    /** The thread's default model, effort and permission mode (unset = unchanged). */
    updateThreadSettings(threadId: string, settings: { model?: string; effort?: string; permissionMode?: string }): Fx<ThreadRow>;
    renameThread(threadId: string, title: string): Fx<ThreadRow>;
    beginTitle(threadId: string, automatic: boolean, context?: string, provisional?: string): Fx<ThreadRow | undefined>;
    finishTitle(threadId: string, revision: bigint, title: string): Fx<boolean>;
    /** Records the model, effort and permission mode a turn is started with. */
    setTurnSettings(turnId: string, settings: { model: string; effort: string; permissionMode: string }): Fx<void>;
    /** Oldest queued user turn of an idle, ready thread with no StartTurn in the outbox yet. */
    nextTurn(threadId: string): Fx<TurnRow | undefined>;
    runningTurn(threadId: string): Fx<TurnRow | undefined>;
    turnsOf(threadId: string): Fx<ReadonlyArray<TurnRow>>;
    /** First task in the visible history, including the fork's inherited prefix. */
    titleInput(threadId: string): Fx<TurnRow | undefined>;
    /** A queued or running turn fails here (e.g. it could not start): the error, where it came from, its code. */
    failTurn(turnId: string, error: string, source: "platform" | "harness", code?: string): Fx<void>;
    /** Pending interactions of the thread's finished turns expire (nothing can answer them any more). */
    expireEndedInteractions(threadId: string): Fx<ui.Interaction[]>;
    /**
     * Ends running worker turns that no longer run on their worker (docs/durability.md, 3.4): the given turns,
     * or every running turn of the worker's threads except `keep` (its Hello.running_turns). The turn ends as
     * interrupted by the system with the reason and the thread is idle again; its pending interactions expire and
     * its steers that did not join it are dropped (pump queues them). A late turn_finished from the worker (e.g. the
     * outcome its harness transcript records) still sets the real outcome.
     */
    endLostTurns(input: { workerId: string; reason: string } & ({ turnIds: readonly string[] } | { keep: readonly { threadId: string; turnId: string }[] })): Fx<{
      turns: { threadId: string; turnId: string }[];
      interactions: ui.Interaction[];
    }>;
    snapshot(threadId: string): Fx<{
      thread: ThreadRow;
      turns: (TurnRow & { inherited?: boolean })[];
      items: ui.TimelineItem[];
      interactions: ui.Interaction[];
      notices: ui.ThreadNotice[];
      lastSeq: bigint;
    }>;
    /** Current state of one of the thread's own items. */
    threadItem(threadId: string, itemId: string): Fx<Item | undefined>;
    // outbox
    enqueueCommand(input: { workerId: string; threadId?: string; turnId?: string; command: MessageInitShape<typeof CommandSchema>; ttlSeconds: number }): Fx<Command>;
    pendingCommands(workerId: string): Fx<Command[]>;
    commandDone(commandId: string, ok: boolean, result: JsonValue): Fx<void>;
    // interactions
    recordInteraction(request: InteractionRequest): Fx<ui.Interaction>;
    /** Answered by the user, or by the parent thread's agent (answer_interaction on the agent bus). */
    answerInteraction(requestId: string, by: { userId: string } | { threadId: string }, answer: ui.AnswerInteractionRequest): Fx<ui.Interaction>;
    pendingInteractions(threadId: string): Fx<ui.Interaction[]>;
    interactionAnswer(requestId: string): Fx<{ threadId: string; answer: ui.AnswerInteractionRequest } | undefined>;
    interactionEvent(requestId: string): Fx<{ seq: bigint; event: import("@open-agents/contracts").ThreadEvent } | undefined>;
  } & ThreadLifecycle
>()("open-agents/gateway/GatewayStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      GatewayStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const one = <A>(rows: ReadonlyArray<A>, what: string): Effect.Effect<A, NotFound> =>
          rows[0] === undefined ? Effect.fail(new NotFound(`${what} not found`)) : Effect.succeed(rows[0]);

        /**
         * A workspace directory on a worker, normalized: absolute and not
         * already a workspace of the project there (`except`: the workspace being moved).
         */
        const workspaceRoot = (input: { projectId: string; workerId: string; rootPath: string; except?: string }) =>
          Effect.gen(function* () {
            const { projectId, workerId, rootPath } = input;
            // A project spans workers (Linux, macOS, Windows): the path follows the worker's rules.
            const workers = yield* sql<{ os: string }>`
              SELECT w.os FROM workers w
               WHERE w.id = ${workerId}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL`;
            const worker = workers[0];
            if (!worker) return yield* Effect.fail(new NotFound("worker not found"));
            const style = pathStyle(worker.os, rootPath);
            if (!isAbsolutePath(rootPath, style)) return yield* Effect.fail(new Invalid("root path must be absolute"));
            const root = normalizePath(rootPath, style);
            // The core asks the worker to validate existence; the worker checks again at thread start.
            const existing = yield* sql<{ id: string; root_path: string }>`
              SELECT id, root_path FROM project_workspaces
               WHERE project_id = ${projectId}::uuid AND worker_id = ${workerId}::uuid AND archived_at IS NULL`;
            const key = pathKey(root, style, worker.os);
            if (existing.some((w) => w.id !== input.except && pathKey(w.root_path, style, worker.os) === key)) {
              return yield* Effect.fail(new Invalid(`${root} is already a workspace of this project on this worker`));
            }
            return root;
          });

        /** An active workspace of a project the user owns. */
        const ownedWorkspace = (ownerUserId: string, workspaceId: string) =>
          Effect.gen(function* () {
            return yield* one(
              yield* sql<{ project_id: string; worker_id: string; root_path: string; label: string }>`
                SELECT w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ${workspaceId}::uuid AND p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL AND p.archived_at IS NULL AND p.kind <> 'scratch'`,
              "workspace",
            );
          });

        const threadSelect = (where: string, extraColumns = "") => `
          -- An asynchronous question (wait=false) needs the user only once the agent has stopped working.
          SELECT t.*, (SELECT p.kind FROM projects p WHERE p.id = t.project_id) AS project_kind, ${extraColumns} (SELECT count(*) FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND (i.question_wait IS DISTINCT FROM false OR t.status NOT IN ('running', 'creating'))) AS pending_interactions,
                 greatest(t.created_at, (SELECT max(greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at)))
                                           FROM turns u WHERE u.thread_id = t.id)) AS last_activity_at,
                 (SELECT g.status FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled') LIMIT 1) AS goal_status,
                 (SELECT count(*) FROM thread_items b WHERE b.thread_id = t.id AND b.type = 'background_task' AND b.status = 'in_progress') AS background_tasks,
                 (SELECT u.status FROM turns u
                   WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                     AND u.last_seq > coalesce((SELECT r.seen_seq FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), 0)
                   ORDER BY u.last_seq DESC LIMIT 1) AS unseen_result,
                 (SELECT u.status FROM turns u WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                   ORDER BY u.ordinal DESC LIMIT 1) AS last_turn_status,
                 coalesce((SELECT r.marked_unread FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), false) AS marked_unread,
                 (SELECT a.title FROM threads a WHERE a.id = t.archived_by_thread_id AND a.deleted_at IS NULL) AS archived_by_thread_title,
                 CASE WHEN t.kind = 'side' THEN
                   (SELECT left(m.content->'agentMessage'->>'text', ${LAST_MESSAGE_PREVIEW}) FROM thread_items m
                     WHERE m.thread_id = t.id AND m.type = 'agent_message' ORDER BY m.first_seq DESC LIMIT 1) END AS last_message,
                 (SELECT (ft.ordinal - (SELECT count(*) FROM turns w WHERE w.thread_id = ft.thread_id AND w.withdrawn IS NOT NULL AND w.ordinal < ft.ordinal))::int
                    FROM turns ft WHERE ft.id = t.fork_after_turn_id) AS fork_after_turn_ordinal
            FROM threads t ${where}`;

        /**
         * The turn a fork starts after (CreateThreadRequest.fork_at_turn_id): in the visible history of the thread
         * forked from (its own turns or those it inherits, up to its fork point), ended, and with a fork point at
         * the provider. A turn without one (it ended before the provider started it) cannot be forked at: the
         * adapters would copy the whole history instead.
         */
        const forkPoint = (ownerUserId: string, request: ui.CreateThreadRequest) =>
          Effect.gen(function* () {
            const from = request.forkThreadId || request.parentThreadId;
            if (!from) return yield* Effect.fail(new Invalid("fork_at_turn_id needs the thread to fork from (fork_thread_id)"));
            if (request.parentThreadId && !request.fork) return yield* Effect.fail(new Invalid("fork_at_turn_id with a parent needs fork"));
            const rows = yield* sql<TurnRow & { provider: string; provider_thread_id: string | null }>`
              SELECT u.*, s.provider, s.provider_thread_id FROM turns u
                JOIN thread_fork_chain(${from}::uuid) c ON c.thread_id = u.thread_id
                JOIN threads s ON s.id = u.thread_id
                JOIN threads f ON f.id = ${from}::uuid
               WHERE u.id = ${request.forkAtTurnId}::uuid AND f.owner_user_id = ${ownerUserId}::uuid
                 AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)`;
            const point = rows[0];
            if (!point) return yield* Effect.fail(new Invalid("the turn is not in this thread's history"));
            if (!["completed", "failed", "interrupted"].includes(point.status)) {
              return yield* Effect.fail(new Invalid(`turn ${point.ordinal} is ${point.status}: a fork starts after an ended turn`));
            }
            if (!point.provider_turn_ref || !point.provider_thread_id) {
              return yield* Effect.fail(new Invalid(`turn ${point.ordinal} never reached ${point.provider === "claude" ? "Claude" : "Codex"}, so there is no point to fork at; fork from an earlier turn`));
            }
            return point;
          });

        const store: GatewayStore["Service"] = {
          connectors: connectorStore(sql, secretsKey),
          ...threadSecretsStore(sql, secretsKey),
          ...threadLifecycle(sql, (input) => store.enqueueCommand(input)),
          ensureUser: (email, displayName) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`
                INSERT INTO users (id, email, display_name, role) VALUES (${Bun.randomUUIDv7()}::uuid, ${email}, ${displayName}, 'admin')
                ON CONFLICT (email) DO UPDATE SET display_name = users.display_name RETURNING id`;
              return (yield* one(rows, "user")).id;
            }),

          authenticateWorker: (credential) =>
            sql<{ id: string }>`SELECT id FROM workers WHERE credential_hash = ${hash(credential)} AND revoked_at IS NULL AND archived_at IS NULL`.pipe(
              Effect.map((rows) => rows[0]?.id),
            ),

          addWorker: ({ name, ownerUserId }) =>
            Effect.gen(function* () {
              const workerId = Bun.randomUUIDv7();
              const credential = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
              yield* sql`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES (${workerId}::uuid, ${ownerUserId}::uuid, ${name}, ${hash(credential)})`;
              return { workerId, credential };
            }),

          workerConnected: (workerId, instanceId, hello) =>
            Effect.gen(function* () {
              const capabilities = JSON.stringify({
                providers: hello.providers.map((p) => ({ provider: Provider[p.provider], available: p.available, version: p.version })),
                // Where the worker keeps attachments (paths in the platform note); empty = it cannot take them.
                attachmentsRoot: hello.attachmentsRoot,
                scratchRoot: hello.scratchRoot,
                homeDirectory: hello.homeDirectory,
              });
              yield* sql`
                UPDATE workers SET os = ${hello.host?.os ?? ""}, arch = ${hello.host?.arch ?? ""}, version = ${hello.host?.workerVersion ?? ""},
                                   capabilities = capabilities || ${capabilities}::jsonb || ${JSON.stringify({ hostname: hello.host?.hostname ?? "" })}::jsonb,
                                   last_seen_at = now()
                 WHERE id = ${workerId}::uuid`;
              yield* sql`
                INSERT INTO worker_connections (worker_id, instance_id, epoch) VALUES (${workerId}::uuid, ${instanceId}, 1)
                ON CONFLICT (worker_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, epoch = worker_connections.epoch + 1, connected_at = now()`;
            }),

          workerSeen: (workerId) => sql`UPDATE workers SET last_seen_at = now() WHERE id = ${workerId}::uuid`.pipe(Effect.asVoid),

          journalCursors: (workerId, journalId) =>
            sql<{ thread_id: string; acked_seq: bigint }>`
              SELECT thread_id, acked_seq FROM worker_journal_cursors WHERE worker_id = ${workerId}::uuid AND journal_id = ${journalId}`.pipe(
              Effect.map((rows) => rows.map((r) => ({ threadId: r.thread_id, lastSeq: BigInt(r.acked_seq) }))),
            ),

          setWorkerConfig: (workerId, config, updatedBy, secretRefs = {}) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{ version: bigint }>`SELECT version FROM worker_configs WHERE worker_id = ${workerId}::uuid FOR UPDATE`;
                const version = (rows[0] ? BigInt(rows[0].version) : 0n) + 1n;
                const document = toJson(WorkerConfigSchema, create(WorkerConfigSchema, { ...config, version })) as {
                  profiles?: { id?: string; apiKey?: unknown; env?: { secret?: boolean; value?: unknown }[] }[];
                };
                for (const profile of document.profiles ?? []) {
                  if (profile.apiKey) return yield* Effect.fail(new Invalid(`profile ${profile.id}: pass API keys as secret references`));
                  // Secret variables only through the provider instances (InstanceStore), which store them encrypted.
                  if (profile.env?.some((v) => v.secret && v.value)) return yield* Effect.fail(new Invalid(`profile ${profile.id}: secret variables go through the profile settings`));
                  const ref = profile.id ? secretRefs[profile.id] : undefined;
                  if (ref) profile.apiKey = { secretRef: ref };
                }
                yield* sql`
                  INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES (${workerId}::uuid, ${version}, ${JSON.stringify(document)}::jsonb, ${updatedBy}::uuid)
                  ON CONFLICT (worker_id) DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`;
                yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${workerId}::uuid`;
                for (const secretId of Object.values(secretRefs)) {
                  yield* sql`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES (${workerId}::uuid, ${secretId}::uuid) ON CONFLICT DO NOTHING`;
                }
                return version;
              }),
            ),

          putSecret: ({ ownerUserId, name, plaintext, createdBy }) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`
                INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${ownerUserId}::uuid, ${name}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${createdBy}::uuid)
                ON CONFLICT (owner_user_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, rotated_at = now()
                RETURNING id`;
              return (yield* one(rows, "secret")).id;
            }),

          workerConfig: (workerId) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ config: { profiles?: { apiKey?: unknown; env?: { value?: unknown }[] }[] } & Record<string, unknown> }>`
                SELECT config FROM worker_configs WHERE worker_id = ${workerId}::uuid`;
              const config = rows[0]?.config;
              if (!config) return undefined;
              // Resolve {"secretRef": id} placeholders right before sending; plaintext never touches the table.
              const resolve = (value: unknown) =>
                Effect.gen(function* () {
                  const ref = (value as { secretRef?: string } | undefined)?.secretRef;
                  if (!ref) return value;
                  const secret = yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets WHERE id = ${ref}::uuid`;
                  return secret[0] ? decryptSecret(secretsKey, secret[0].ciphertext) : "";
                });
              for (const profile of config.profiles ?? []) {
                if (profile.apiKey) profile.apiKey = yield* resolve(profile.apiKey);
                for (const variable of profile.env ?? []) variable.value = yield* resolve(variable.value);
              }
              return fromJson(WorkerConfigSchema, config as JsonValue);
            }),

          configApplied: (workerId, report) =>
            sql`
              UPDATE worker_configs SET applied_version = ${report.version}, applied_ok = ${report.applied}, applied_at = now(),
                                        apply_report = ${JSON.stringify(toJson(ConfigAppliedSchema, report))}::jsonb
               WHERE worker_id = ${workerId}::uuid AND version >= ${report.version}`.pipe(Effect.asVoid),

          listWorkers: (online, ownerUserId) =>
            Effect.gen(function* () {
              const rows = yield* sql<{
                id: string; name: string; os: string; version: string; capabilities: { hostname?: string; homeDirectory?: string }; last_seen_at: Date | null;
                config: JsonValue | null; config_version: bigint | null; applied_version: bigint | null; apply_report: JsonValue | null;
              }>`
                SELECT w.id, w.name, w.os, w.version, w.capabilities, w.last_seen_at,
                       c.config, c.version AS config_version, c.applied_version, c.apply_report
                  FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
                 WHERE w.archived_at IS NULL AND w.revoked_at IS NULL
                   AND (${ownerUserId ?? null}::uuid IS NULL OR w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId ?? null}::uuid)
                 ORDER BY w.name`;
              return rows.map((r) => {
                const report = r.apply_report ? fromJson(ConfigAppliedSchema, r.apply_report, { ignoreUnknownFields: true }) : undefined;
                const config = r.config as { profiles?: { id?: string; displayName?: string }[] } | null;
                // Names the user gave: the configuration knows them before the worker reports (older workers never do).
                for (const profile of report?.profiles ?? []) {
                  profile.displayName ||= config?.profiles?.find((p) => p.id === profile.id)?.displayName ?? "";
                }
                return create(ui.WorkerSchema, {
                  id: r.id,
                  name: r.name,
                  online: online.has(r.id),
                  hostname: r.capabilities?.hostname ?? "",
                  os: r.os,
                  version: r.version,
                  providers: report?.providers ?? [],
                  profiles: report?.profiles ?? [],
                  homeDirectory: r.capabilities?.homeDirectory ?? "",
                  configVersion: r.config_version ? BigInt(r.config_version) : 0n,
                  appliedVersion: r.applied_version ? BigInt(r.applied_version) : 0n,
                  configIssues: report?.issues ?? [],
                  ...(r.last_seen_at && { lastSeenAt: timestampFromDate(new Date(r.last_seen_at)) }),
                });
              });
            }),

          createProject: (ownerUserId, name) =>
            Effect.gen(function* () {
              const trimmed = name.trim();
              if (!trimmed) return yield* Effect.fail(new Invalid("project name is required"));
              if (trimmed.length > 200 || /[\r\n\p{Cc}]/u.test(trimmed)) return yield* Effect.fail(new Invalid("project name must be one line with 1–200 characters"));
              const id = Bun.randomUUIDv7();
              const slug = `${slugify(trimmed)}-${id.slice(-6)}`;
              yield* sql`INSERT INTO projects (id, owner_user_id, name, slug) VALUES (${id}::uuid, ${ownerUserId}::uuid, ${trimmed}, ${slug})`;
              return create(ui.ProjectSchema, { id, name: trimmed, slug, kind: "project", workspaces: [] });
            }),

          lockProject: (ownerUserId, projectId) => Effect.gen(function* () {
            const rows = yield* sql`SELECT id FROM projects WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL FOR UPDATE`;
            if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
          }),

          renameProject: (ownerUserId, projectId, name) => Effect.gen(function* () {
            const trimmed = name.trim();
            if (!trimmed || trimmed.length > 200 || /[\r\n\p{Cc}]/u.test(trimmed)) return yield* Effect.fail(new Invalid("project name must be one line with 1–200 characters"));
            const rows = yield* sql`UPDATE projects SET name = ${trimmed} WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL RETURNING id`;
            if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
          }),

          archiveProject: (ownerUserId, projectId) => Effect.gen(function* () {
            const rows = yield* sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL RETURNING id`;
            if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
            yield* sql`UPDATE project_workspaces SET archived_at = coalesce(archived_at, now()) WHERE project_id = ${projectId}::uuid`;
            yield* sql`UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, version = version + 1
              WHERE project_id = ${projectId}::uuid AND status IN ('active', 'paused')`;
          }),

          createWorkspace: ({ projectId, workerId, rootPath, label }) =>
            Effect.gen(function* () {
              const project = yield* one(yield* sql<{ kind: string }>`SELECT kind FROM projects WHERE id = ${projectId}::uuid AND archived_at IS NULL FOR SHARE`, "project");
              if (project.kind === "scratch") return yield* Effect.fail(new Invalid("scratch workspaces are managed automatically"));
              const root = yield* workspaceRoot({ projectId, workerId, rootPath });
              const id = Bun.randomUUIDv7();
              yield* sql`
                INSERT INTO project_workspaces (id, project_id, worker_id, root_path, label)
                VALUES (${id}::uuid, ${projectId}::uuid, ${workerId}::uuid, ${root}, ${label})`;
              return create(ui.WorkspaceSchema, { id, projectId, workerId, rootPath: root, label });
            }),

          updateWorkspace: (ownerUserId, { workspaceId, rootPath, label }) =>
            Effect.gen(function* () {
              const current = yield* ownedWorkspace(ownerUserId, workspaceId);
              const root =
                rootPath === undefined
                  ? current.root_path
                  : yield* workspaceRoot({ projectId: current.project_id, workerId: current.worker_id, rootPath, except: workspaceId });
              const nextLabel = label ?? current.label;
              yield* sql`UPDATE project_workspaces SET root_path = ${root}, label = ${nextLabel} WHERE id = ${workspaceId}::uuid`;
              return create(ui.WorkspaceSchema, { id: workspaceId, projectId: current.project_id, workerId: current.worker_id, rootPath: root, label: nextLabel });
            }),

          removeWorkspace: (ownerUserId, workspaceId) =>
            Effect.gen(function* () {
              const current = yield* ownedWorkspace(ownerUserId, workspaceId);
              yield* sql`UPDATE project_workspaces SET archived_at = now() WHERE id = ${workspaceId}::uuid AND archived_at IS NULL`;
              return create(ui.WorkspaceSchema, {
                id: workspaceId,
                projectId: current.project_id,
                workerId: current.worker_id,
                rootPath: current.root_path,
                label: current.label,
              });
            }),

          listProjects: (ownerUserId) =>
            sql.withTransaction(Effect.gen(function* () {
              // Provision lazily for existing users too. The owner index and project lock serialize
              // concurrent overview requests; no worker directory is created until CreateThread.
              yield* sql`INSERT INTO projects (id, owner_user_id, name, slug, kind)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${ownerUserId}::uuid, 'No project', 'system-scratch', 'scratch')
                ON CONFLICT (owner_user_id) WHERE kind = 'scratch' DO NOTHING`;
              const scratch = (yield* sql<{ id: string }>`SELECT id FROM projects WHERE owner_user_id = ${ownerUserId}::uuid AND kind = 'scratch' FOR UPDATE`)[0]!;
              const workers = yield* sql<{ id: string; os: string; capabilities: { scratchRoot?: string } }>`
                SELECT w.id, w.os, w.capabilities FROM workers w JOIN worker_configs c ON c.worker_id = w.id
                WHERE (w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId}::uuid)
                  AND w.archived_at IS NULL AND w.revoked_at IS NULL`;
              for (const worker of workers) {
                const root = worker.capabilities.scratchRoot;
                if (!root) continue;
                const style = pathStyle(worker.os, root);
                if (!isAbsolutePath(root, style)) continue;
                const base = scratchBase(root, ownerUserId, style);
                const current = (yield* sql<{ id: string; root_path: string }>`SELECT id, root_path FROM project_workspaces
                  WHERE project_id = ${scratch.id}::uuid AND worker_id = ${worker.id}::uuid AND archived_at IS NULL`)[0];
                if (!current) yield* sql`INSERT INTO project_workspaces (id, project_id, worker_id, root_path)
                  VALUES (${Bun.randomUUIDv7()}::uuid, ${scratch.id}::uuid, ${worker.id}::uuid, ${base})`;
                else if (current.root_path !== base) yield* sql`UPDATE project_workspaces SET root_path = ${base} WHERE id = ${current.id}::uuid`;
              }
              const projects = yield* sql<{ id: string; name: string; slug: string; kind: string }>`
                SELECT id, name, slug, kind FROM projects WHERE owner_user_id = ${ownerUserId}::uuid AND archived_at IS NULL ORDER BY (kind = 'scratch') DESC, created_at`;
              const workspaces = yield* sql<{ id: string; project_id: string; worker_id: string; root_path: string; label: string }>`
                SELECT w.id, w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w
                  JOIN projects p ON p.id = w.project_id JOIN workers host ON host.id = w.worker_id
                 WHERE p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL
                   AND (p.kind <> 'scratch' OR (host.archived_at IS NULL AND host.revoked_at IS NULL
                     AND (host.owner_user_id IS NULL OR host.owner_user_id = ${ownerUserId}::uuid)
                     AND coalesce(host.capabilities->>'scratchRoot', '') <> ''))
                 ORDER BY w.created_at`;
              return projects.map((p) =>
                create(ui.ProjectSchema, {
                  ...p,
                  workspaces: workspaces
                    .filter((w) => w.project_id === p.id)
                    .map((w) => ({ id: w.id, projectId: w.project_id, workerId: w.worker_id, rootPath: w.root_path, label: w.label })),
                }),
              );
            })),

          createThread: (ownerUserId, request) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const workspace = yield* one(
                  yield* sql<{ id: string; project_id: string; worker_id: string; root_path: string; os: string; project_kind: string }>`
                    SELECT pw.id, pw.project_id, pw.worker_id, pw.root_path, w.os, p.kind AS project_kind
                      FROM project_workspaces pw JOIN workers w ON w.id = pw.worker_id JOIN projects p ON p.id = pw.project_id
                     WHERE pw.id = ${request.workspaceId}::uuid AND pw.project_id = ${request.projectId}::uuid
                       AND p.owner_user_id = ${ownerUserId}::uuid AND p.archived_at IS NULL
                       AND (w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId}::uuid)
                       AND w.archived_at IS NULL AND w.revoked_at IS NULL
                       AND (pw.archived_at IS NULL OR ${request.parentThreadId !== "" || request.forkAtTurnId !== ""}::boolean)
                     FOR SHARE OF p`,
                  "workspace",
                );
                const provider = request.provider === Provider.CLAUDE ? "claude" : "codex";
                const id = Bun.randomUUIDv7();
                const parent = request.parentThreadId ? yield* store.thread(request.parentThreadId) : undefined;
                if (parent?.archived_at) return yield* Effect.fail(new Invalid("parent thread is archived"));
                if (parent && parent.workspace_id !== workspace.id) {
                  return yield* Effect.fail(new Invalid("a side thread runs in its parent's workspace"));
                }
                if (parent && request.fork && parent.provider !== provider) {
                  return yield* Effect.fail(new Invalid(`a fork keeps its parent's provider (${parent.provider})`));
                }
                // Fork source and point: the parent's latest completed turn (pinned by the database), or a chosen turn.
                let forkSource = parent && request.fork ? parent.id : null;
                let forkAfterTurn: string | null = null;
                if (request.forkAtTurnId) {
                  const point = yield* forkPoint(ownerUserId, request);
                  if (point.provider !== provider) return yield* Effect.fail(new Invalid(`a fork keeps its source's provider (${point.provider})`));
                  if (parent && point.thread_id !== parent.id) return yield* Effect.fail(new Invalid("a side thread forks at a turn of its parent"));
                  forkSource = point.thread_id;
                  forkAfterTurn = point.id;
                }
                // A thread may start below the workspace root, never outside it (paths follow the worker's OS).
                const style = pathStyle(workspace.os, workspace.root_path);
                const inherited = parent ?? (workspace.project_kind === "scratch" && forkSource ? yield* store.thread(forkSource) : undefined);
                if (workspace.project_kind === "scratch" && !inherited && request.cwd) {
                  return yield* Effect.fail(new Invalid("a new no-project thread gets its own scratch directory"));
                }
                const requested = request.cwd ? normalizePath(request.cwd, style) : undefined;
                if ((workspace.project_kind !== "scratch" || !inherited) && requested && (!isAbsolutePath(request.cwd, style) || !isWithinWorkspace(requested, workspace.root_path, style, workspace.os))) {
                  return yield* Effect.fail(new Invalid(`${request.cwd} is outside the workspace ${workspace.root_path}`));
                }
                const cwd = inherited?.cwd ?? (workspace.project_kind === "scratch" ? scratchCwd(workspace.root_path, id, style) : requested ?? workspace.root_path);
                const settings = JSON.stringify({
                  model: request.model,
                  effort: request.effort,
                  permissionMode: permissionModeName(request.permissionMode) || "ASK",
                  instructions: request.instructions,
                });
                yield* sql`
                  INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, runtime, provider,
                                       provider_profile_id, worker_id, workspace_id, cwd, fork_source_thread_id, fork_after_turn_id, settings, status, title, title_source)
                  VALUES (${id}::uuid, ${workspace.project_id}::uuid, ${ownerUserId}::uuid, ${parent ? "side" : "main"},
                          ${parent?.id ?? null}::uuid, ${parent?.root_thread_id ?? id}::uuid, ${parent ? parent.depth + 1 : 0}, 'worker', ${provider},
                          ${request.providerProfileId && request.providerProfileId !== "native" ? request.providerProfileId : null}, ${workspace.worker_id}::uuid, ${workspace.id}::uuid, ${cwd},
                          ${forkSource}::uuid, ${forkAfterTurn}::uuid, ${settings}::jsonb, 'creating', ${request.title.trim() || request.initialMessage.trim().split("\n")[0]?.slice(0, 60) || "New thread"}, ${request.title.trim() ? "user" : "provisional"})`;
                if (request.initialMessage.trim()) {
                  yield* sql`
                    INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                    VALUES (${Bun.randomUUIDv7()}::uuid, ${id}::uuid, 1, 'user', ${ownerUserId}::uuid, ${request.clientRequestId || null},
                            ${JSON.stringify({ text: request.initialMessage })}::jsonb)`;
                }
                return yield* store.thread(id);
              }),
            ),

          thread: (threadId, includeDeleted = false) =>
            sql.unsafe<ThreadRow>(threadSelect("WHERE t.id = $1::uuid AND (t.deleted_at IS NULL OR $2::boolean)"), [threadId, includeDeleted]).pipe(Effect.flatMap((rows) => one(rows, "thread"))),

          markThreadSeen: (ownerUserId, threadId, upToSeq) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ seen_seq: string }>`
                INSERT INTO thread_reads (user_id, thread_id, seen_seq)
                SELECT t.owner_user_id, t.id, least(${upToSeq.toString()}::bigint, t.last_seq) FROM threads t
                 WHERE t.id = ${threadId}::uuid AND t.owner_user_id = ${ownerUserId}::uuid AND t.deleted_at IS NULL
                ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = greatest(thread_reads.seen_seq, EXCLUDED.seen_seq),
                  marked_unread = false, seen_at = now()
                 WHERE thread_reads.seen_seq < EXCLUDED.seen_seq OR thread_reads.marked_unread
                RETURNING seen_seq`;
              if (rows.length > 0) return true;
              yield* one(yield* sql<{ id: string }>`SELECT id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid AND deleted_at IS NULL`, "thread");
              return false;
            }),

          listThreads: (ownerUserId, projectId, includeArchived = false, sidebarOnly = false) =>
            sql.unsafe<ThreadRow>(threadSelect(`WHERE t.owner_user_id = $1::uuid AND ($2::uuid IS NULL OR t.project_id = $2::uuid)
              AND t.deleted_at IS NULL AND (CASE WHEN $4::boolean THEN ((t.archived_at IS NULL AND NOT EXISTS
                (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id AND parent.archived_at IS NOT NULL)) OR
                (t.kind = 'side' AND EXISTS (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id
                  AND parent.owner_user_id = t.owner_user_id AND parent.archived_at IS NULL AND parent.deleted_at IS NULL)))
                ELSE ($3::boolean OR t.archived_at IS NULL) END)
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL) ORDER BY t.created_at`),
              [ownerUserId, projectId || null, includeArchived, sidebarOnly]),

          listArchivedThreads: (ownerUserId, request) => Effect.gen(function* () {
            const page = yield* Effect.try({ try: () => archivedPage(ownerUserId, request), catch: (cause) => new Invalid((cause as Error).message) });
            const where = `WHERE t.owner_user_id = $1::uuid AND t.deleted_at IS NULL AND t.archived_at IS NOT NULL
              AND (cardinality($2::uuid[]) = 0 OR t.project_id = ANY($2::uuid[]))
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL
                AND ($3 = '' OR strpos(lower(t.title), $3) > 0 OR strpos(lower(p.name), $3) > 0
                  OR EXISTS (SELECT 1 FROM threads child WHERE child.parent_thread_id = t.id AND child.deleted_at IS NULL
                    AND child.owner_user_id = t.owner_user_id AND strpos(lower(child.title), $3) > 0)))
              AND NOT (t.kind = 'side' AND EXISTS (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id
                AND parent.owner_user_id = t.owner_user_id AND parent.deleted_at IS NULL))`;
            const params = [ownerUserId, page.projects, page.query];
            const totalCount = (yield* sql.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM threads t ${where}`, params))[0]!.count;
            if (request.countOnly) return { threads: [], sideThreads: [], totalCount, nextPageToken: "" };
            const rows = yield* sql.unsafe<ThreadRow & { archive_cursor: string }>(threadSelect(`${where}
              AND ($4::timestamptz IS NULL OR (t.archived_at, t.id) < ($4::timestamptz, $5::uuid))
              ORDER BY t.archived_at DESC, t.id DESC LIMIT $6`,
              `to_char(t.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archive_cursor,`),
              [...params, page.cursor?.at ?? null, page.cursor?.id ?? null, page.size + 1]);
            const threads = rows.slice(0, page.size);
            const last = threads.at(-1);
            const sideThreads = threads.length ? yield* sql.unsafe<ThreadRow>(threadSelect(`WHERE t.parent_thread_id = ANY($1::uuid[])
              AND t.owner_user_id = $2::uuid AND t.deleted_at IS NULL ORDER BY t.created_at`), [threads.map((t) => t.id), ownerUserId]) : [];
            return { threads, sideThreads: [...sideThreads], totalCount, nextPageToken: rows.length > page.size && last ? page.token(last.archive_cursor, last.id) : "" };
          }),

          threadSpec: (row) =>
            create(ThreadSpecSchema, {
              threadId: row.id,
              provider: row.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
              providerProfileId: row.provider_profile_id ?? "",
              cwd: row.cwd ?? "",
              scratch: row.project_kind === "scratch",
              model: row.settings.model ?? "",
              instructions: row.settings.instructions ?? "",
              permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
              // Agent bus tools for every worker thread: Codex dynamicTools, Claude MCP (docs/agent-bus.md).
              enableAgentBus: row.runtime === "worker",
              providerThreadId: row.provider_thread_id ?? "",
              depth: row.depth,
            }),

          setThreadStatus: (threadId, status, detail) =>
            sql`UPDATE threads SET status = ${status}, status_detail = ${detail} WHERE id = ${threadId}::uuid AND deleted_at IS NULL AND archived_at IS NULL`.pipe(Effect.asVoid),

          enqueueTurn: ({ threadId, text, userId, clientRequestId, model = "", effort = "", permissionMode = "", input }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const attachments = input?.attachments ?? [];
                if (!text.trim() && attachments.length === 0 && !input?.quotes?.length) return yield* Effect.fail(new Invalid("message is empty"));
                const id = Bun.randomUUIDv7();
                const rows = yield* sql<TurnRow>`
                  INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input, model, effort, permission_mode)
                  SELECT ${id}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'user', ${userId}::uuid,
                         ${clientRequestId || null}, ${JSON.stringify(input ?? { text })}::jsonb, ${model}, ${effort}, ${permissionMode}
                    FROM turns WHERE thread_id = ${threadId}::uuid
                  ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
                  RETURNING *`;
                if (!rows[0]) {
                  return yield* one(yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`, "turn");
                }
                if (attachments.length > 0) {
                  // Each attachment goes with one message: a concurrent send of the same file fails here and rolls back.
                  const bound = yield* sql`
                    UPDATE attachments SET thread_id = ${threadId}::uuid, turn_id = ${id}::uuid
                     WHERE id = ANY(${`{${attachments.map((a) => a.id).join(",")}}`}::uuid[]) AND owner_user_id = ${userId}::uuid AND thread_id IS NULL
                    RETURNING id`;
                  if (bound.length !== attachments.length) return yield* Effect.fail(new Invalid("an attachment was already sent with another message"));
                }
                return rows[0];
              }),
            ),

          turnByClientRequest: (threadId, clientRequestId) =>
            clientRequestId
              ? sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`.pipe(Effect.map((rows) => rows[0]))
              : Effect.succeed(undefined),

          updateThreadSettings: (threadId, settings) =>
            sql`
              UPDATE threads SET settings = settings || ${JSON.stringify(settings)}::jsonb WHERE id = ${threadId}::uuid AND archived_at IS NULL`.pipe(
              Effect.andThen(store.thread(threadId)),
            ),

          renameThread: (threadId, title) =>
            sql`UPDATE threads SET title = ${title}, title_source = 'user', title_revision = title_revision + 1
                 WHERE id = ${threadId}::uuid AND archived_at IS NULL`.pipe(Effect.andThen(store.thread(threadId))),

          beginTitle: (threadId, automatic, context, provisional) =>
            sql<ThreadRow>`UPDATE threads SET title_revision = title_revision + 1, title_requested = true,
                  title_context = CASE WHEN title_context = '' THEN ${context ?? ""} ELSE title_context END,
                  title = CASE WHEN ${automatic} THEN ${provisional ?? "New thread"} ELSE title END
                WHERE id = ${threadId}::uuid AND archived_at IS NULL
                  AND (NOT ${automatic} OR (title_source = 'provisional' AND NOT title_requested))
                RETURNING *`.pipe(Effect.map((rows) => rows[0])),

          finishTitle: (threadId, revision, title) =>
            sql`UPDATE threads SET title = ${title}, title_source = 'generated'
                 WHERE id = ${threadId}::uuid AND title_revision = ${revision} AND archived_at IS NULL
                 RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),

          setTurnSettings: (turnId, { model, effort, permissionMode }) =>
            sql`UPDATE turns SET model = ${model}, effort = ${effort}, permission_mode = ${permissionMode} WHERE id = ${turnId}::uuid`.pipe(Effect.asVoid),

          nextTurn: (threadId) =>
            sql<TurnRow>`
              SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
               WHERE u.thread_id = ${threadId}::uuid AND u.status = 'queued' AND t.provider_thread_id IS NOT NULL
                 AND t.status IN ('idle', 'interrupted', 'failed') AND t.deleted_at IS NULL AND t.archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = u.thread_id AND r.status = 'running')
                 AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))
               ORDER BY u.ordinal LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

          runningTurn: (threadId) =>
            sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND status = 'running' LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

          turnsOf: (threadId) => sql<TurnRow>`
            SELECT u.*, s.*, (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id WHERE bc.id = u.bot_call_id) AS bot_id FROM turns u LEFT JOIN turn_sources s ON s.turn_id = u.id
             WHERE u.thread_id = ${threadId}::uuid ORDER BY u.ordinal`,

          titleInput: (threadId) => sql<TurnRow>`
            SELECT u.* FROM thread_fork_chain(${threadId}::uuid) c JOIN turns u ON u.thread_id = c.thread_id
             WHERE u.trigger IN ('user', 'goal', 'agent_bus')
               AND COALESCE(u.input->>'message', u.input->>'text', '') <> ''
               AND (c.level = 0 OR (u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)))
             ORDER BY c.level DESC, u.ordinal LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

          failTurn: (turnId, error, source, code) =>
            sql`
              UPDATE turns SET status = 'failed', error = ${error}, error_source = ${source}, error_code = ${code || null}, completed_at = now()
               WHERE id = ${turnId}::uuid AND status IN ('queued', 'running')`.pipe(Effect.asVoid),

          expireEndedInteractions: (threadId) =>
            sql.withTransaction(Effect.gen(function* () {
              yield* sql`SELECT id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;
              const rows = yield* sql<InteractionRow>`
              UPDATE interaction_requests q SET status = 'expired', answered_at = now()
                FROM turns u
               WHERE u.id = q.turn_id AND q.thread_id = ${threadId}::uuid AND q.status = 'pending'
                 AND u.status IN ('completed', 'interrupted', 'failed', 'cancelled') AND q.question_call_id IS NULL
              RETURNING q.*`;
              for (const row of rows) yield* writeInteractionTimeline(sql, row);
              return rows.map(toInteraction);
            })),

          endLostTurns: (input) =>
            sql.withTransaction(
              Effect.gen(function* () {
                // Only ids that can be turns here (a malformed report must not fail the reconcile).
                const keep = "keep" in input ? input.keep.map((t) => t.turnId).filter((id) => UUID.test(id)) : [];
                const only = "turnIds" in input ? [...input.turnIds] : null;
                const turns = yield* sql<{ id: string; thread_id: string }>`
                  UPDATE turns u SET status = 'interrupted', interrupt_source = 'system', interrupt_reason = ${input.reason}, completed_at = now()
                    FROM threads t
                   WHERE t.id = u.thread_id AND t.worker_id = ${input.workerId}::uuid AND t.runtime = 'worker' AND u.status = 'running'
                     AND (${only}::uuid[] IS NULL OR u.id = ANY(${only}::uuid[])) AND NOT (u.id = ANY(${keep}::uuid[]))
                  RETURNING u.id, u.thread_id`;
                if (turns.length === 0) return { turns: [], interactions: [] };
                const ids = turns.map((t) => t.id);
                const threads = [...new Set(turns.map((t) => t.thread_id))];
                yield* sql`
                  UPDATE threads t SET status = 'idle'
                   WHERE t.id = ANY(${threads}::uuid[]) AND t.status IN ('running', 'waiting_input')
                     AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')`;
                const interactions = yield* sql<InteractionRow>`
                  UPDATE interaction_requests SET status = 'expired', answered_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status = 'pending' AND question_call_id IS NULL
                  RETURNING *`;
                for (const row of interactions) yield* writeInteractionTimeline(sql, row);
                yield* sql`
                  UPDATE turn_steers SET status = 'dropped', reason = ${`the turn ended before the message could join it (${input.reason})`}, updated_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'accepted')`;
                return { turns: turns.map((t) => ({ threadId: t.thread_id, turnId: t.id })), interactions: interactions.map(toInteraction) };
              }),
            ),

          snapshot: (threadId) =>
            Effect.gen(function* () {
              const thread = yield* store.thread(threadId);
              // A fork shows the history it inherits (thread_items_view / thread_fork_chain), marked as inherited.
              const inheritedTurns = yield* sql<TurnRow>`
                SELECT u.*, s.*, (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id WHERE bc.id = u.bot_call_id) AS bot_id FROM thread_fork_chain(${threadId}::uuid) c
                  JOIN turns u ON u.thread_id = c.thread_id LEFT JOIN turn_sources s ON s.turn_id = u.id
                 WHERE c.level > 0 AND u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)
                 ORDER BY c.level DESC, u.ordinal`;
              const turns = yield* store.turnsOf(threadId);
              const itemRows = yield* sql<{ thread_id: string; content: JsonValue; turn_id: string | null; first_seq: bigint; last_seq: bigint; inherited: boolean }>`
                SELECT thread_id, content, turn_id, first_seq, last_seq, inherited FROM thread_items_view(${threadId}::uuid)`;
              const items = itemRows.map((r) =>
                create(ui.TimelineItemSchema, {
                  item: fromJson(ItemSchema, r.content),
                  turnId: r.turn_id ?? "",
                  firstSeq: BigInt(r.first_seq),
                  lastSeq: BigInt(r.last_seq),
                  inherited: r.inherited,
                  fromThreadId: r.inherited ? r.thread_id : "",
                }),
              );
              const noticeRows = yield* sql<{ seq: bigint; turn_id: string | null; payload: JsonValue; occurred_at: Date }>`
                SELECT seq, turn_id, payload, occurred_at FROM (
                  SELECT seq, turn_id, payload, occurred_at FROM thread_events
                   WHERE thread_id = ${threadId}::uuid AND kind = 'notice' ORDER BY seq DESC LIMIT 200) n
                 ORDER BY seq`;
              const notices = noticeRows.flatMap((r) => {
                const event = fromJson(ThreadEventSchema, r.payload);
                return event.body.case === "notice"
                  ? [create(ui.ThreadNoticeSchema, { seq: BigInt(r.seq), turnId: r.turn_id ?? "", notice: event.body.value, occurredAt: timestampFromDate(new Date(r.occurred_at)) })]
                  : [];
              });
              const interactions = yield* store.pendingInteractions(threadId);
              return {
                thread,
                turns: [...inheritedTurns.map((t) => ({ ...t, inherited: true })), ...turns],
                items,
                interactions,
                notices,
                lastSeq: BigInt(thread.last_seq),
              };
            }),

          threadItem: (threadId, itemId) =>
            sql<{ content: JsonValue }>`SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId}`.pipe(
              Effect.map((rows) => (rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined)),
            ),

          enqueueCommand: ({ workerId, threadId, turnId, command, ttlSeconds }) =>
            Effect.gen(function* () {
              const message = create(CommandSchema, { ...command, commandId: command.commandId || Bun.randomUUIDv7() } as MessageInitShape<typeof CommandSchema>);
              yield* sql`
                INSERT INTO worker_commands (id, worker_id, thread_id, turn_id, kind, payload, expires_at)
                VALUES (${message.commandId}::uuid, ${workerId}::uuid, ${threadId ?? null}::uuid, ${turnId ?? null}::uuid,
                        ${message.kind.case ?? "unknown"}, ${toBinary(CommandSchema, message)}, now() + make_interval(secs => ${ttlSeconds}))
                ON CONFLICT (id) DO NOTHING`;
              return message;
            }),

          pendingCommands: (workerId) =>
            sql<OutboxRow>`
              SELECT id, worker_id, thread_id, turn_id, kind, payload FROM worker_commands
               WHERE worker_id = ${workerId}::uuid AND status IN ('pending', 'delivered') AND expires_at > now() ORDER BY created_at`.pipe(
              Effect.map((rows) => rows.map((r) => fromBinary(CommandSchema, r.payload))),
            ),

          commandDone: (commandId, ok, result) =>
            sql`
              UPDATE worker_commands SET status = ${ok ? "completed" : "failed"}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
               WHERE id = ${commandId}::uuid`.pipe(Effect.asVoid),

          recordInteraction: (request) =>
            sql.withTransaction(Effect.gen(function* () {
              const thread = yield* store.thread(request.threadId);
              yield* sql`SELECT id FROM threads WHERE id = ${request.threadId}::uuid FOR UPDATE`;
              const known = yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${request.requestId}::uuid`;
              if (known[0]) return toInteraction(known[0]);
              const rows = yield* sql<InteractionRow>`
                INSERT INTO interaction_requests (id, thread_id, turn_id, item_id, kind, tool_name, request, routed_to)
                VALUES (${request.requestId}::uuid, ${request.threadId}::uuid,
                        (SELECT id FROM turns WHERE id = ${request.turnId || null}::uuid AND thread_id = ${request.threadId}::uuid),
                        ${request.itemId || null}, ${interactionKind(request.kind)}, ${request.toolName}, ${request.requestJson || "{}"}::jsonb,
                        ${thread.interaction_route})
                ON CONFLICT (id) DO UPDATE SET request = interaction_requests.request
                RETURNING *`;
              const row = yield* one(rows, "interaction");
              yield* writeInteractionTimeline(sql, row);
              return toInteraction(row);
            })),

          answerInteraction: (requestId, by, answer) =>
            sql.withTransaction(Effect.gen(function* () {
              const found = yield* one(yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid`, "interaction");
              yield* sql`SELECT id FROM threads WHERE id = ${found.thread_id}::uuid FOR UPDATE`;
              const current = yield* one(yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid FOR UPDATE`, "interaction");
              if (current.status !== "pending") return yield* Effect.fail(new Invalid(`interaction is already ${current.status}`));
              if (current.question_call_id && !answer.cancelled) {
                const decoded = decodeUserAnswers(answer.answerJson, (current.request as unknown as { questions: UserQuestion[] }).questions);
                if (Result.isFailure(decoded)) return yield* Effect.fail(new Invalid(decoded.failure));
              }
              const status = answer.cancelled
                ? "cancelled"
                : current.kind === "permission"
                  ? answer.allow
                    ? "allowed"
                    : "declined"
                  : "answered";
              // Cancellation has no author (interaction_requests_answered_by).
              const userId = "userId" in by && !answer.cancelled ? by.userId : null;
              const threadId = "threadId" in by && !answer.cancelled ? by.threadId : null;
              const rows = yield* sql<InteractionRow>`
                UPDATE interaction_requests SET status = ${status}, answered_by = ${userId}::uuid, answered_by_thread_id = ${threadId}::uuid,
                       answered_at = now(),
                       response = ${JSON.stringify({ allow: answer.allow, allowForSession: answer.allowForSession, message: answer.message, answerJson: answer.answerJson, cancelled: answer.cancelled })}::jsonb,
                       answer_delivery = CASE WHEN question_call_id IS NOT NULL THEN 'pending' ELSE NULL END
                 WHERE id = ${requestId}::uuid RETURNING *`;
              // The parent agent no longer needs the turn that would have asked it.
              yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE interaction_request_id = ${requestId}::uuid AND status = 'queued'`;
              const row = yield* one(rows, "interaction");
              yield* writeInteractionTimeline(sql, row);
              return toInteraction(row);
            })),

          interactionEvent: (requestId) => sql<{ seq: string; payload: JsonValue }>`
            SELECT e.seq, e.payload FROM interaction_requests q
              JOIN thread_items i ON i.thread_id = q.thread_id AND i.item_id = 'interaction-' || q.id::text
              JOIN thread_events e ON e.thread_id = i.thread_id AND e.seq = i.last_seq
             WHERE q.id = ${requestId}::uuid`.pipe(Effect.map((rows) => rows[0] ? { seq: BigInt(rows[0].seq), event: fromJson(ThreadEventSchema, rows[0].payload) } : undefined)),

          pendingInteractions: (threadId) =>
            sql<InteractionRow>`SELECT * FROM interaction_requests WHERE thread_id = ${threadId}::uuid AND status = 'pending' ORDER BY created_at`.pipe(
              Effect.map((rows) => rows.map(toInteraction)),
            ),

          interactionAnswer: (requestId) =>
            sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid AND status <> 'pending'`.pipe(
              Effect.map((rows) => {
                const row = rows[0];
                if (!row?.response) return undefined;
                return { threadId: row.thread_id, answer: create(ui.AnswerInteractionRequestSchema, { requestId, ...(row.response as object) }) };
              }),
            ),
        };
        return GatewayStore.of(store);
      }),
    );
}

export interface InteractionRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  kind: string;
  tool_name: string;
  request: JsonValue;
  status: string;
  routed_to: string;
  response: JsonValue | null;
  created_at: Date;
  answered_by?: string | null;
  answered_by_thread_id?: string | null;
  question_call_id?: string | null;
  question_wait?: boolean | null;
  answer_delivery?: string | null;
  answer_steer_id?: string | null;
  answer_turn_id?: string | null;
}

export function toInteraction(row: InteractionRow): ui.Interaction {
  return create(ui.InteractionSchema, {
    requestId: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id ?? "",
    itemId: row.item_id ?? "",
    kind: row.kind === "permission" ? InteractionKind.PERMISSION : row.kind === "question" ? InteractionKind.QUESTION : InteractionKind.ELICITATION,
    toolName: row.tool_name,
    requestJson: JSON.stringify(row.request),
    status: row.status,
    routedTo: row.routed_to,
    createdAt: timestampFromDate(new Date(row.created_at)),
    asynchronous: row.question_wait === false,
  });
}

function interactionKind(kind: InteractionKind): string {
  return kind === InteractionKind.QUESTION ? "question" : kind === InteractionKind.ELICITATION ? "elicitation" : "permission";
}

/** A stored mode (PermissionMode enum name, as in threads.settings); '' or unknown = UNSPECIFIED. */
export function permissionModeOf(name: string | undefined): PermissionMode {
  const mode = PermissionMode[(name ?? "") as keyof typeof PermissionMode];
  return mode === undefined || mode === PermissionMode.UNSPECIFIED ? PermissionMode.UNSPECIFIED : mode;
}

/** The stored name of a mode; UNSPECIFIED = '' (the thread's default). */
export function permissionModeName(mode: PermissionMode): string {
  return mode === PermissionMode.UNSPECIFIED ? "" : (PermissionMode[mode] ?? "");
}

export function toUiThread(row: ThreadRow): ui.Thread {
  return create(ui.ThreadSchema, {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind === "side" ? ui.ThreadKind.SIDE : ui.ThreadKind.MAIN,
    parentThreadId: row.parent_thread_id ?? "",
    title: row.title,
    titleSource: row.title_source,
    provider: row.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
    providerProfileId: row.provider_profile_id ?? "",
    model: row.settings.model ?? "",
    effort: row.settings.effort ?? "",
    permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
    workerId: row.worker_id ?? "",
    workspaceId: row.workspace_id ?? "",
    cwd: row.cwd ?? "",
    status: row.status,
    agentId: row.agent_id ?? "",
    spawnedByAgent: row.origin === "agent",
    scheduleId: row.schedule_id ?? "",
    scheduleName: row.schedule_name ?? "",
    scheduleRun: row.schedule_run ?? 0,
    statusDetail: row.status_detail ?? "",
    lastSeq: BigInt(row.last_seq),
    createdAt: timestampFromDate(new Date(row.created_at)),
    pendingInteractions: Number(row.pending_interactions ?? 0),
    forkSourceThreadId: row.fork_source_thread_id ?? "",
    forkAfterTurnId: row.fork_after_turn_id ?? "",
    forkAfterTurnOrdinal: row.fork_after_turn_ordinal ?? 0,
    rootThreadId: row.root_thread_id,
    interactionRoute: row.interaction_route,
    ...(row.last_activity_at && { lastActivityAt: timestampFromDate(new Date(row.last_activity_at)) }),
    goalStatus: row.goal_status ?? "",
    backgroundTasks: Number(row.background_tasks ?? 0),
    runtime: row.runtime,
    lastMessage: row.last_message ?? "",
    unseenResult: row.unseen_result ?? "",
    markedUnread: row.marked_unread ?? false,
    ...(row.archived_at && { archivedAt: timestampFromDate(new Date(row.archived_at)) }),
    archivedBy: row.archived_by ?? "",
    archivedByThreadId: row.archived_by_thread_id ?? "",
    archivedByThreadTitle: row.archived_by_thread_title ?? "",
    ...(row.deleted_at && { deletedAt: timestampFromDate(new Date(row.deleted_at)) }),
    lastTurnStatus: row.last_turn_status ?? "",
  });
}

/** Joined columns describing the thread an agent's steer or turn came from (ui.AgentSender). */
export interface SenderColumns {
  source_thread_id?: string | null;
  source_title?: string | null;
  source_provider?: string | null;
  source_profile_id?: string | null;
  source_model?: string | null;
  source_project_id?: string | null;
  source_worker_id?: string | null;
}

export function toUiSender(row: SenderColumns): ui.AgentSender | undefined {
  if (!row.source_thread_id || row.source_title == null) return undefined;
  return create(ui.AgentSenderSchema, {
    threadId: row.source_thread_id,
    title: row.source_title,
    provider: row.source_provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
    providerProfileId: row.source_profile_id ?? "",
    model: row.source_model ?? "",
    projectId: row.source_project_id ?? "",
    workerId: row.source_worker_id ?? "",
  });
}

export function toUiTurn(row: TurnRow & { inherited?: boolean }): ui.Turn {
  // Agent-sent input (a task, a message, a report) names its sender; other sources show their own way.
  const sender = row.source_kind === "task" || row.source_kind === "message" || row.source_kind === "report" ? toUiSender(row) : undefined;
  return create(ui.TurnSchema, {
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    trigger: row.trigger,
    inputText: row.input?.text ?? "",
    error: row.error ?? "",
    interruptReason: row.status === "interrupted" ? (row.interrupt_reason ?? "") : "",
    errorSource: row.status === "failed" ? (row.error_source ?? "") : "",
    errorCode: row.status === "failed" ? (row.error_code ?? "") : "",
    interruptSource: row.status === "interrupted" ? (row.interrupt_source ?? "") : "",
    queuedAt: timestampFromDate(new Date(row.queued_at)),
    ...(row.started_at && { startedAt: timestampFromDate(new Date(row.started_at)) }),
    ...(row.completed_at && { completedAt: timestampFromDate(new Date(row.completed_at)) }),
    ...(row.usage && { usage: fromJson(UsageSchema, row.usage) }),
    hops: row.hops ?? 0,
    inherited: row.inherited ?? false,
    fromThreadId: row.inherited ? row.thread_id : "",
    messageText: row.input?.message ?? row.input?.text ?? "",
    platformNote: row.input?.note ?? "",
    sourceStatus: row.source_status ?? "",
    questionKind: row.question_kind ?? "",
    questionTool: row.question_tool ?? "",
    backgroundItemIds: row.background_item_ids ?? [],
    botId: row.bot_id ?? "",
    sourceKind: row.source_kind ?? "",
    sourceThreadId: row.source_thread_id ?? "",
    scheduleId: row.schedule_id ?? "",
    interactionRequestId: row.interaction_request_id ?? "",
    model: row.model ?? "",
    effort: row.effort ?? "",
    permissionMode: permissionModeOf(row.permission_mode),
    goalId: row.goal_id ?? "",
    attachments: (row.input?.attachments ?? []).map(toUiAttachment),
    withdrawn: row.withdrawn ?? "",
    revision: row.revision ?? 0,
    mentions: mentionsFromJson(row.input?.mentions),
    quotes: (row.input?.quotes ?? []).map(toUiQuote),
    ...(sender && { sender }),
  });
}

function hash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "project"
  );
}


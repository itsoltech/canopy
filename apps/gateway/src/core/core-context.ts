import { isErrorObject } from "./error-cause.ts";
import { PermissionMode, Provider, ui, type MentionCatalog, type ThreadEvent } from "@canopy/contracts";
import { Predicate, Schema, type ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { type WorkerConnection } from "../worker-link/index.ts";
import { type AttachmentLimits } from "@canopy/domain";
import { AttachmentStore } from "../store/attachments.ts";
import {
  AgentBusStore,
  BackgroundTaskStore,
  GatewayStore,
  GoalStore,
  harnessOf,
  Ingest,
  InstanceStore,
  ModelStore,
  permissionModeName,
  QueueStore,
  SettingsStore,
  SteerStore,
  type ThreadRow,
  type TurnRow,
} from "../store/index.ts";
import { BotStore } from "../bots/store.ts";
import type { BotModel } from "../bots/types.ts";
import { ActionContext } from "./action-context.ts";
import { type GatewayUpdatesOptions } from "../updates/runtime.ts";
import { type CliLatestOptions } from "./cli-tools.ts";

/**
 * The gateway's runtime state machine (docs/ui-api.md, docs/durability.md):
 * - workers: connect, outbox redelivery, transcript ingest + ack after commit, config, interactions,
 * - scheduler: one running turn per thread; a turn starts only once the thread is ready,
 * - command results: failed thread creation / turn start / goal command become visible state, not silent drops,
 * - worker restarts: turns the worker no longer runs (Hello.running_turns, an interrupt it cannot carry out) end here,
 * - turn ends: whatever the worker reported, nothing of a finished turn stays open (settle), and a sweep finds and
 *   fixes what still is (at start and periodically; docs/durability.md, "Stany tury i wątku"),
 * - agent bus: tool calls from agents (side threads, messages, waits), notifications, questions to parents,
 * - models and steering: workers' model catalogs, per-turn model and effort, messages into a running turn,
 * - UI operations and live fan-out through the hub.
 */

export type CoreServices =
  | GatewayStore
  | Ingest
  | AgentBusStore
  | SettingsStore
  | ModelStore
  | SteerStore
  | QueueStore
  | GoalStore
  | InstanceStore
  | AttachmentStore
  | BackgroundTaskStore
  | BotStore
  | SqlClient.SqlClient;

export type CoreRuntime = ManagedRuntime.ManagedRuntime<CoreServices, unknown>;

export interface GatewayCoreOptions {
  readonly updates?: Partial<Omit<GatewayUpdatesOptions, "persistence" | "authenticate">>;
  readonly mobileGatewayUrl?: string;
  readonly publicGatewayUrl?: string;
  readonly sshSecretsKey?: Buffer;
  /** Test-only sources of the latest provider CLI versions (docs/provider-cli.md). */
  readonly cliLatest?: CliLatestOptions;
  readonly runtime: CoreRuntime;
  readonly instanceId: string;
  /** Single development user until authentication lands (docs/ui-api.md). */
  readonly userId: string;
  readonly log?: (message: string) => void;
  readonly commandTimeoutMs?: number;
  /** Per file, per message and how many files (docs/ui-api.md, "Załączniki"); defaults: DEFAULT_ATTACHMENT_LIMITS. */
  readonly attachmentLimits?: AttachmentLimits;
  /** How long a Claude task that completed by itself waits for Claude's own wake-up turn (core/background-tasks.ts). */
  readonly backgroundGraceMs?: number;
  readonly botModel?: BotModel;
  readonly botClock?: () => Date;
  readonly secretTtlMs?: number;
}

/** Bytes per BlobChunk on the worker link (attachments down, previews up). */
export const BLOB_CHUNK_BYTES = 256 * 1024;

/** Largest preview a worker may upload (it scales images to at most 2000 px). */
export const MAX_PREVIEW_BYTES = 8 * 1024 ** 2;

export const PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type TurnInputJson = TurnRow["input"];

/** How long the gateway reuses a worker's mention catalog (refresh skips it; the worker keeps its own). */
export const CATALOG_TTL_MS = 30_000;

/** Where a model is chosen: an existing thread, or a new one (workspace, provider, profile). */
export type ModelScope = { thread: ThreadRow } | { workspaceId: string; provider: Provider; profileId: string };

// A steer waits as long as a turn would: a worker that is back too late answers "not running" and it is queued.
export const TTL = {
  createThread: 24 * 3600,
  startTurn: 24 * 3600,
  interruptTurn: 60,
  steerTurn: 24 * 3600,
  setGoal: 3600,
  stopTask: 300,
} as const;

/** Why the gateway ended a turn its worker no longer runs (turns.interrupt_reason). */
export const WORKER_RESTARTED = "worker restarted";

/** Audit reasons of items the gateway closes (thread_events.raw of its item_completed). */
export const SETTLE_TURN_ENDED = "the turn ended while the item was still open";

export const SETTLE_SWEEP = "sweep: the item's turn is over";

/** The sweep treats a thread as running without a turn only after this long (a turn_started may be on its way). */
export const SWEEP_STALE_SECONDS = 60;

export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Worker error codes that mean the harness refused or failed (worker runtime/host.ts); the rest are ours. */
export const HARNESS_ERROR_CODES: ReadonlySet<string> = new Set(["HARNESS_ERROR"]);

/** Claude's goal condition limit (Claude Code rejects longer ones). */
export const MAX_OBJECTIVE = 4000;

/** The steer an event concerns: its user_message item (client_id) or a steer_dropped notice. */
export function steerOf(event: ThreadEvent): string | undefined {
  const body = event.body;

  if (body.case === "itemCompleted" && body.value.item?.content.case === "userMessage") {
    const clientId = body.value.item.content.value.clientId;

    return clientId && clientId !== event.turnId ? clientId : undefined;
  }

  if (body.case === "notice" && body.value.code === "steer_dropped") {
    try {
      const id = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(body.value.dataJson || "{}"))["input_id"];

      return Predicate.isString(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * A requested permission mode as stored ('' = UNSPECIFIED: no override / unchanged). Any mode is the user's to
 * choose for their thread (FULL_AUTO too: still sandboxed to the workspace by both harnesses); agents cannot
 * set one, the agent bus has no tool for it.
 */
export function checkedPermissionMode(mode: PermissionMode): string {
  if (mode !== PermissionMode.UNSPECIFIED && PermissionMode[mode] === undefined)
    throw new InvalidError(`unknown permission mode ${mode}`);

  return permissionModeName(mode);
}

/** Whether a database constraint caused the error (driver errors carry it somewhere in the cause chain). */
export function violates(cause: unknown, constraint: string): boolean {
  for (let current = cause, i = 0; i < 8 && isErrorObject(current); i++, current = current.cause) {
    if (current.constraint === constraint) return true;
  }

  return false;
}

/** Favorites are a short list of known shapes: a provider, an optional profile, a model id. */
export function checkFavorites(favorites: ui.ModelFavorites): void {
  if (favorites.models.length > 200) throw new InvalidError("at most 200 favorite models");

  for (const f of favorites.models) {
    if (!harnessOf(f.provider)) throw new InvalidError("a favorite model needs a provider");

    if (!f.model || f.model.length > 200 || f.profileId.length > 100)
      throw new InvalidError("a favorite model needs a model id (at most 200 characters)");
  }

  const keys = favorites.models.map((f) => `${f.provider}/${f.profileId}/${f.model}`);

  if (new Set(keys).size !== keys.length) throw new InvalidError("duplicate favorite model");
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });

    return true;
  } catch {
    return false;
  }
}

/** Message with its causes (driver errors keep the useful part, e.g. the violated constraint, in the cause). */
export function describeError(cause: unknown): string {
  const parts: string[] = [];

  for (let current = cause, i = 0; current && i < 5; i++) {
    const message = current instanceof Error ? current.message : String(current);
    const detail = isErrorObject(current) ? current.detail : undefined;
    parts.push(Predicate.isString(detail) && detail ? `${message} (${detail})` : message);

    if (!isErrorObject(current)) break;
    current = current.cause;
  }

  return [...new Set(parts)].join(": ");
}

export class UnavailableError extends Error {
  override readonly name = "UnavailableError";
}

export class InvalidError extends Error {
  override readonly name = "InvalidError";
}

export const coreState: unique symbol = Symbol("GatewayCore state");

export class GatewayCoreState {
  actions!: ActionContext;

  options!: GatewayCoreOptions;

  readonly journalIds = new Map<string, string>();

  /** Threads whose events failed to store on a connection: skipped until the worker reconnects and resends. */
  readonly blocked = new WeakMap<WorkerConnection, Set<string>>();

  /** Mention catalogs by worker + provider + profile + folder (the composer asks on every popup). */
  readonly catalogs = new Map<string, { at: number; catalog: MentionCatalog }>();

  /** Previews a worker is uploading (BlobChunk), by sha256, until their last chunk. */
  readonly uploads = new WeakMap<
    WorkerConnection,
    Map<string, { chunks: Uint8Array[]; size: number; mimeType: string }>
  >();

  sweepTimer!: ReturnType<typeof setInterval> | undefined;

  pumpAdmissions = 0;

  readonly updateDeferred = new Set<string>();

  readonly titleJobs = new Map<string, Promise<void>>();

  readonly titlePreparing = new Set<string>();
}

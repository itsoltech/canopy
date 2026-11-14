import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ServerNotification } from "@canopy/codex-protocol";
import {
  InteractionRequestSchema,
  type AgentToolCall,
  type AgentToolResult,
  type InteractionRequest,
  type InteractionResponse,
  type Mention,
  type ThreadEvent,
  type ThreadSpec,
} from "@canopy/contracts";
import type { ViewImageResult } from "../../images/index.ts";
import { Predicate, Schema, type Semaphore } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { CodexAppServer } from "./app-server.ts";
import type { CodexAppServerLaunch } from "./launch.ts";
import { CodexEventMapper } from "./mapping.ts";
import { RolloutTail } from "./rollout.ts";
import type { codexConnectorMcp } from "./connector-mcp.ts";

export class CodexThreadError extends Schema.TaggedError<CodexThreadError>()("CodexThreadError", {
  threadId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  /** Codex itself refused or failed the request (an app-server error), not the worker. */
  harness: Schema.optional(Schema.Boolean),
}) {}

export type InteractionInit = Omit<MessageInitShape<typeof InteractionRequestSchema>, "threadId" | "requestId">;

export interface CodexThreadsOptions {
  onUsage?(snapshot: import("@canopy/contracts").ProviderUsageSnapshot): void;
  readonly launch: CodexAppServerLaunch;
  readonly clientVersion: string;
  /** Resolved provider profile by id ("" = native). */
  profile(id: string): ResolvedProfile | undefined;
  /** Repair an imported copy for the selected connection; returns its verified private rollout path. */
  importedResumePath?(spec: ThreadSpec, modelProvider: string): string | undefined;
  /** Called after an event is safely in the journal (e.g. send it to the gateway when connected). */
  publish(event: ThreadEvent): void;
  /** Structured lifecycle diagnostics; never includes input, output, paths or RPC errors. */
  log?(message: string): void;
  /** A notification has finished journaling; the host may recheck a pending drain. */
  onActivitySettled?(): void;
  /** Asks the platform (gateway -> user or parent agent) and waits for the answer. */
  interact(request: InteractionRequest): Promise<InteractionResponse>;
  /** Runs an agent bus tool call on the gateway (docs/agent-bus.md) and waits for its result. */
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
  /** The device owner's default reasoning effort (their config.toml, default-effort.ts); read on every use. */
  configuredEffort?(): string | undefined;
  /** The platform's view_image (worker-side; docs/agent-bus.md), offered to every new thread as a dynamic tool. */
  viewImage?(threadId: string, path: string): Promise<ViewImageResult>;
  /** Adds what the transcript shows of an event (image previews) before it is journaled. */
  enrich?(init: ThreadEventInit): Promise<ThreadEventInit>;
  /** Account connectors (Codex apps) are on for this worker (NativeToolsConfig.connectors): list them for mentions. */
  readonly connectors?: boolean;
}

export interface Entry {
  readonly platformId: string;
  readonly codexId: string;
  readonly mapper: CodexEventMapper;
  /** Platform turn ids awaiting the authoritative turn/start response. */
  readonly pendingTurns: string[];
  /** Notifications wait for admission to bind command turns, without blocking other threads. */
  readonly pendingNotifications: ServerNotification[];
  readonly recording: Semaphore.Semaphore;
  recordingNotifications: boolean;
  /** Warn at most once per completed turn about unexpected late model events. */
  readonly warnedLateTurns: Set<string>;
  readonly codexToPlatform: Map<string, string>;
  readonly platformToCodex: Map<string, string>;
  readonly commandTurns: Set<string>;
  /** Codex's rollout of the thread: items app-server does not notify about (docs/codex-adapter.md, "Code mode"). */
  readonly rollout: { readonly tail: RolloutTail; turn?: string | undefined; readonly ended: Set<string> } | undefined;
  /** Codex turns that completed: a steer for them falls back to the queue. */
  readonly finishedTurns: Set<string>;
  /** Steered inputs (SteerTurn.input_id) accepted by Codex. */
  readonly steered: Set<string>;
  /** Mentions of the platform's inputs by client id (turn id, steer input id), put on Codex's userMessage echo. */
  /** Input text and mentions by client id: the userMessage echo shows the text as sent (one text, its ranges). */
  readonly mentions: Map<string, { readonly text: string; readonly mentions: readonly Mention[] }>;
  /** Codex turns the platform asked to interrupt (their interruption is the user's). */
  readonly interrupting: Set<string>;
  readonly rolloutPath: string | null;
}

export interface CodexThreadContext {
  options: CodexThreadsOptions;
  codex: CodexAppServer["Service"];
  journal: Journal["Service"];
  byPlatform: Map<string, Entry>;
  byCodex: Map<string, Entry>;
  connectorCatalog: Map<string, ThreadSpec["connectorTools"]>;
  connectorMcp?: ReturnType<typeof codexConnectorMcp>;
  failure: string | undefined;
}

export const isAppServerError = Predicate.isTagged("CodexAppServerError");

export const fail = (threadId: string, operation: string) => (error: { message: string }) =>
  new CodexThreadError({
    threadId,
    operation,
    message: error.message,
    ...(isAppServerError(error) && { harness: true }),
  });

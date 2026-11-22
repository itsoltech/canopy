import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentToolCall,
  AgentToolResult,
  AgentTool,
  InteractionRequest,
  InteractionResponse,
  Mention,
  PermissionMode,
  ThreadEvent,
  ThreadSpec,
} from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import type { ClaudeProviderSettings } from "@canopy/domain/provider-settings";
import { Schema } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import type { NativeToolPolicy } from "../native-tools.ts";
import type { Env, ProfileUserConfiguration, ResolvedProfile } from "../profiles.ts";
import type { ViewImageResult } from "../../images/index.ts";
import { ClaudeEventMapper } from "./mapping.ts";
import type { AutoAllow } from "./permissions.ts";
import type { LocalAgentToolMcpServer } from "../../agent-tools/index.ts";
import type { ClaudeUsage } from "./usage.ts";

export class ClaudeThreadError extends Schema.TaggedError<ClaudeThreadError>()("ClaudeThreadError", {
  threadId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface ClaudeThreadsOptions {
  onUsage?(snapshot: import("@canopy/contracts").ProviderUsageSnapshot): void;
  /** Isolated Claude config dir (CLAUDE_CONFIG_DIR, claude/home.ts). */
  readonly home: string;
  /** How long an idle process that had background tasks waits for a turn Claude starts itself (default 3 s). */
  readonly idleGraceMs?: number;
  /** How often background task output files are read (default 1 s). */
  readonly outputPollMs?: number;
  /**
   * stop_reason of background tasks the runtime's closing kills: worker_shutdown when the worker stops, else
   * worker_restart (the runtime is rebuilt). Default worker_restart.
   */
  closingReason?(): string;
  /** Claude Code executable; the SDK's bundled one when absent. */
  readonly executable?: string;
  readonly nativeTools: NativeToolPolicy;
  readonly baseEnv: Env;
  /**
   * The configured default effort for a model known by these names (default-effort.ts).
   * A turn without an effort of its own uses this default when the model supports it.
   */
  configuredEffort?(names: readonly string[]): string | undefined;
  profile(id: string): ResolvedProfile | undefined;
  /**
   * An instance's own runtime (global provider instances, docs/worker-config.md, section 9): its Claude config dir,
   * executable and Claude Code flags. Absent = the runtime's home and executable.
   */
  runtimeOf?(profile: ResolvedProfile, spec?: ThreadSpec): ClaudeInstanceRuntime | undefined;
  publish(event: ThreadEvent): void;
  /** Archived/deleted threads keep their tasks, but cannot start native completion turns. */
  allowProviderTurn?(threadId: string): boolean;
  /** An event has finished journaling; the host may recheck a pending drain. */
  onActivitySettled?(): void;
  interact(request: InteractionRequest): Promise<InteractionResponse>;
  callTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
  /** The thread's attachments directory: readable without a prompt (additionalDirectories). */
  attachmentsDir?(threadId: string): string;
  secretsDir?(threadId: string): string;
  /** The platform's view_image (worker-side; docs/agent-bus.md). */
  viewImage?(threadId: string, cwd: string, path: string): Promise<ViewImageResult>;
  /** Local automation MCP servers resolved by the worker from gateway-approved tool ids. */
  localMcpServers?(
    tools: readonly AgentTool[],
    threadId: string,
    defaults?: ThreadSpec["agentToolDefaults"],
  ): readonly LocalAgentToolMcpServer[];
  /** Prepares image previews and writes the event to the journal. */
  recordEvent?(
    journal: Journal["Service"],
    threadId: string,
    init: ThreadEventInit,
  ): ReturnType<Journal["Service"]["append"]>;
}

export interface ClaudeInstanceRuntime {
  readonly home: string;
  readonly sourceHome?: string;
  readonly userConfiguration?: ProfileUserConfiguration;
  readonly settings?: ClaudeProviderSettings;
  /** Private platform home, retained as the lookup location of sessions predating durable bindings. */
  readonly platformHome?: string;
  readonly executable?: string;
  /** Claude Code flags (`--flag value` / `--flag`). */
  readonly extraArgs?: Record<string, string | null>;
}

export interface Session {
  serviceTier?: string;
  refreshConnectors(spec: ThreadSpec): Promise<void>;
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly query: Query;
  /** A named sandbox profile is pinned for the lifetime of this process. */
  readonly sandboxProfileDigest?: string | undefined;
  /** The input stream: turn inputs and steered messages. */
  readonly input: AsyncChannel<SDKUserMessage>;
  readonly mapper: ClaudeEventMapper;
  readonly abort: AbortController;
  /** Bus tool_use ids by "name args" from streamed assistant messages, for the MCP handler. */
  readonly busCalls: Map<string, string[]>;
  /** Turn in progress (the platform's or one Claude started itself). */
  turn: SessionTurn | undefined;
  /** Startup/control messages may arrive before StartTurn has submitted its input. */
  admitting: boolean;
  /** Model and effort the process runs with (a later turn may switch the model). */
  model: string;
  /** Permission mode the process runs with; canUseTool reads autoAllow per request (a later turn may switch it). */
  mode: PermissionMode;
  autoAllow: AutoAllow;
  /** Read position in each background task's output file. */
  readonly outputs: Map<string, { offset: number; readonly decoder: TextDecoder }>;
  /** The Claude config dir the session lives in (the instance's own, else the runtime's). */
  readonly home: string;
  /** Read position in the session transcript (goal verdicts). */
  transcript: { path: string | undefined; offset: number; tail: string };
  /** File reads and the events they produce, one at a time. */
  io: Promise<void>;
  hadTasks: boolean;
  closing: boolean;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  done: Promise<void>;
}

export interface SessionTurn {
  readonly turnId: string;
  /** Steered inputs by input id; started once Claude Code took them into the turn (command_lifecycle). */
  readonly steers: Map<
    string,
    { readonly text: string; readonly authorUserId: string; readonly mentions: readonly Mention[]; started: boolean }
  >;
  /** The turn is finishing (result seen, or interrupted): no more steers. */
  ended: boolean;
  interrupting: boolean;
}

export interface ClaudeThreadContext {
  usage: ClaudeUsage;
  options: ClaudeThreadsOptions;
  journal: Journal["Service"];
  sessions: Map<string, Session>;
  started: Set<string>;
  resolvedModels: Map<string, string>;
  modelEfforts: Map<string, readonly string[]>;
  shuttingDown: boolean;
}

export const fail = (threadId: string, operation: string) => (cause: unknown) =>
  new ClaudeThreadError({ threadId, operation, message: cause instanceof Error ? cause.message : String(cause) });

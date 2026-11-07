import { providersOf } from "../providers/profiles.ts";
import { ThreadSecretFiles } from "./thread-secrets.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Provider,
  type AgentToolCall,
  type AgentToolResult,
  type InteractionRequest,
  type InteractionResponse,
  type WorkerConfig,
} from "@canopy/contracts";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { deviceClaudeHome } from "../providers/claude/home.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { deviceCodexHome } from "../providers/codex/home.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { GrokThreads } from "../providers/grok/threads.ts";
import { CliTools } from "../cli-tools/index.ts";
import type { HeadTracker } from "../git/heads.ts";
import { CatalogCache } from "../mentions/catalog.ts";
import { AttachmentFiles } from "../attachments/files.ts";
import { PreviewStore } from "../images/index.ts";
import { WorkerImport } from "../import/service.ts";
import { AccountStatuses } from "../providers/account-status.ts";
import { resolveWorktreeRoots, type WorktreeRoots } from "../git/worktree-roots.ts";

import type { ProviderRuntimeHandle, ProfileModelsInit, WorkerHostOptions } from "./host-types.ts";

export class HostState {
  readonly accounts = new AccountStatuses();
  readonly secrets: ThreadSecretFiles;
  /** Provider CLIs on this device: reports and installs on demand (docs/provider-cli.md). */
  cli!: CliTools;
  /** The live branch of the threads' checkouts (GitHeads, docs/worktrees.md). */
  heads!: HeadTracker;
  /** Provider per thread (from the commands' ThreadSpec): running turns per provider. */
  readonly threadProviders = new Map<string, Provider>();
  /** Turns being admitted per provider (between StartTurn and turnStarted). */
  readonly admittingBy = new Map<Provider, number>();
  readonly generations = new Map<AbortController, Promise<void>>();
  readonly shellRuns = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      startTurn: boolean;
      controller: AbortController;
      pending: Promise<import("@canopy/contracts").ShellResult>;
    }
  >();
  closing = false;
  readonly options: WorkerHostOptions;
  config: AppliedConfig | undefined;
  /** The configuration as received: checked again on ProbeProviders and after a login from the app. */
  received: WorkerConfig | undefined;
  /** Sign-ins from the app in progress, by provider/profile. */
  readonly logins = new Map<string, Promise<unknown>>();
  link: GatewayLink | undefined;
  /** Runtime snapshots per instance; configuration changes drain only the affected instance. */
  readonly codex = new Map<string, ProviderRuntimeHandle<CodexThreads>>();
  readonly claude = new Map<string, ProviderRuntimeHandle<ClaudeThreads>>();
  readonly grok = new Map<string, { key: string; runtime: GrokThreads }>();
  readonly threadInstances = new Map<string, string>();
  readonly runtimeUsers = new Map<string, number>();
  readonly staleRuntimes = new Set<string>();
  runtimeReconcile: Promise<void> = Promise.resolve();
  readonly runtimeWaiters = new Set<() => void>();
  /** The worker is stopping (shutdown): runtimes stay down, tasks they kill end as worker_shutdown. */
  shuttingDown = false;
  readonly codexRestart = new Map<string, Promise<void>>();
  readonly running = new Set<string>();
  updateDraining = false;
  admitting = 0;

  readonly interactions = new Map<string, { request: InteractionRequest; resolve: (r: InteractionResponse) => void }>();
  readonly toolCalls = new Map<string, { call: AgentToolCall; resolve: (r: AgentToolResult) => void }>();
  /** Last model catalog (ModelCatalog), re-sent after a reconnect. */
  catalog: { configVersion: bigint; profiles: ProfileModelsInit[] } | undefined;
  catalogRun = 0;
  /** Taken at start: the Claude runtime points this process's CLAUDE_CONFIG_DIR at the isolated home. */
  readonly deviceHomes: {
    readonly claude: string;
    readonly codex: string;
    readonly grok?: string;
    readonly agents?: string;
    /** The directory of Claude's `.claude.json` when it is not the Claude home (the default home: `~`). */
    readonly claudeAccount?: string;
  };
  /** Claude's mention catalogs (a listing starts Claude Code); Codex answers skills/list from its own cache. */
  readonly catalogs = new CatalogCache();
  /** The isolated Claude config dir per instance (skills and commands). */
  readonly claudeHomes = new Map<string, string>();

  /** Durable Grok sessions of an instance ("" = native): `<data_dir>/grok/<instance>/sessions` (grok/launch.ts). */
  grokSessions(profileId: string): string {
    return join(this.options.dataDir, "grok", profileId || "native", "sessions");
  }

  /** The private Codex home of an instance ("" = native): its shadow home, else `<data_dir>/codex-home`. */
  codexHome(profileId: string): string {
    const id = profileId || "native";

    return (
      instanceShadowHome(this.options.dataDir, "codex", id, this.#runtimeOf(id, "codex")) ??
      join(this.options.dataDir, "codex-home")
    );
  }

  /** The private Claude home of an instance ("" = native), also before its runtime started (docs/import.md). */
  claudeHome(profileId: string): string {
    const id = profileId || "native";
    const known = this.claudeHomes.get(id);

    if (known) return known;

    return (
      instanceShadowHome(this.options.dataDir, "claude", id, this.#runtimeOf(id, "claude")) ??
      join(this.options.dataDir, "claude-home")
    );
  }

  /** The instance's runtime settings for this harness (an id may name instances of other harnesses, too). */
  #runtimeOf(id: string, harness: "claude" | "codex" | "grok") {
    return this.config?.profiles.find((p) => p.config.id === id && providersOf(p.config).includes(harness))?.config
      .runtime;
  }
  readonly files: AttachmentFiles;
  readonly previews: PreviewStore;
  /** CLI import (docs/import.md): scans and reads the device's CLI homes on the owner's request. */
  readonly imports: WorkerImport;
  /** Working directory per thread (from the commands' ThreadSpec): view_image's scope. */
  readonly cwds = new Map<string, string>();
  readonly removingPaths = new Set<string>();
  /** Managed git worktree roots (docs/worktrees.md, "Położenie"). */
  readonly worktreeRoots: WorktreeRoots;
  /** Attachments being fetched (FetchBlob), by request id. */
  readonly fetches = new Map<
    string,
    { chunks: Uint8Array[]; resolve: (data: Uint8Array) => void; reject: (error: Error) => void }
  >();

  constructor(options: WorkerHostOptions) {
    this.options = options;
    this.secrets = new ThreadSecretFiles(options.dataDir);
    const claude = deviceClaudeHome(process.env);

    this.deviceHomes = options.deviceHomes ?? {
      claude,
      codex: deviceCodexHome(process.env),
      grok: process.env["GROK_HOME"] || join(homedir(), ".grok"),
      agents: join(homedir(), ".agents", "skills"),
      // Claude keeps `.claude.json` beside its default home (`~`); with CLAUDE_CONFIG_DIR it is inside that.
      ...(claude === join(homedir(), ".claude") && { claudeAccount: homedir() }),
    };
    this.worktreeRoots = options.worktreeRoots ?? resolveWorktreeRoots({ dataDir: options.dataDir, home: "" });
    this.files = new AttachmentFiles(options.dataDir);
    this.previews = new PreviewStore(options.dataDir);
    this.previews.prune();
    this.imports = new WorkerImport({
      dataDir: options.dataDir,
      homes: () => ({
        claude: this.deviceHomes.claude,
        codex: this.deviceHomes.codex,
        grok: this.deviceHomes.grok ?? join(homedir(), ".grok"),
        // `~/.agents` of the device (its `skills/` is deviceHomes.agents); none when the homes are given (tests).
        ...(this.deviceHomes.agents && { agents: dirname(this.deviceHomes.agents) }),
        ...(this.deviceHomes.claudeAccount && { claudeAccount: this.deviceHomes.claudeAccount }),
      }),
      config: () => this.config,
    });
  }
}

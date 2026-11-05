import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  BackgroundTaskKind,
  Provider,
  type Command,
  type DirectoryEntrySchema,
  type CommandResultSchema,
  ConfigAppliedSchema,
  type Item,
  type ProfileModelsSchema,
  type MentionCatalogSchema,
  type FileSearchResultSchema,
  type GitRefsSchema,
  type WorktreeInfoSchema,
} from "@canopy/contracts";
import { Context, Scope, type ManagedRuntime } from "effect";
import type { DeviceProbe } from "../config/remote.ts";
import { Journal } from "../journal/index.ts";
import type { ProfileRuntimeConfig, ResolvedProfile } from "../providers/profiles.ts";
import type { CliProbe } from "../cli-tools/discovery.ts";
import type { WorktreeRoots } from "../git/worktree-roots.ts";
import type { CheckClock } from "@canopy/domain/update-checks";

export type CommandResultInit = MessageInitShape<typeof CommandResultSchema>;

export type ConfigAppliedInit = MessageInitShape<typeof ConfigAppliedSchema>;

export type DirectoryEntryInit = MessageInitShape<typeof DirectoryEntrySchema>;

export type ProfileModelsInit = MessageInitShape<typeof ProfileModelsSchema>;

export interface CommandOutput {
  readonly workspaceOrigin?: string;
  readonly providerAccounts?: MessageInitShape<typeof CommandResultSchema>["providerAccounts"];
  worktreeStatuses?: MessageInitShape<typeof CommandResultSchema>["worktreeStatuses"];
  worktreeBranchDeleted?: boolean;
  readonly directoryPath?: string;
  readonly generatedText?: string;
  readonly entries?: DirectoryEntryInit[];
  readonly models?: ProfileModelsInit[];
  readonly login?: { verificationUrl: string; userCode: string; loginId: string };
  readonly mentionCatalog?: MessageInitShape<typeof MentionCatalogSchema>;
  readonly fileSearch?: MessageInitShape<typeof FileSearchResultSchema>;
  readonly gitRefs?: MessageInitShape<typeof GitRefsSchema>;
  readonly worktree?: MessageInitShape<typeof WorktreeInfoSchema>;
}

export interface WorkerHostOptions {
  /** Tests can shorten the production two-minute shell deadline. */
  readonly shellTimeoutMs?: number;
  readonly runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  readonly dataDir: string;
  readonly clientVersion: string;
  readonly probe?: DeviceProbe;
  /** Provider CLI discovery (docs/provider-cli.md); default: this device. */
  readonly cliProbe?: CliProbe;
  /** Injectable timer for CLI check scheduling. */
  readonly cliCheckClock?: CheckClock;
  /** Environment of CLI installs (default: the worker's, without secret-looking variables). */
  readonly cliEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * The device owner's Claude and Codex homes (login, default effort). Default: $CLAUDE_CONFIG_DIR / $CODEX_HOME
   * of the worker process at start, else ~/.claude and ~/.codex.
   */
  readonly deviceHomes?: {
    readonly claude: string;
    readonly codex: string;
    readonly grok?: string;
    readonly agents?: string;
  };
  /** Managed worktree roots (resolveWorktreeRoots); default: `<data_dir>/worktrees` only. */
  readonly worktreeRoots?: WorktreeRoots;
  readonly log?: (message: string) => void;
  /** Full access turns (no sandbox, no prompts) are allowed unless the device turned them off (worker.json). */
  readonly fullAccess?: boolean;
}

export interface ProviderRuntimeHandle<S> {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly context: Context.Context<S>;
}

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Deterministic failures are remembered for redelivery; transient ones are not. */
    readonly final: boolean,
  ) {
    super(message);
  }
}

export function kindOf(item: Item): BackgroundTaskKind | undefined {
  return item.content.case === "backgroundTask" ? item.content.value.kind : undefined;
}

export function taskOf(item: Item): string | undefined {
  return item.content.case === "backgroundTask" ? item.content.value.taskId : undefined;
}

/** A profile serves the providers it lists (both by default). */
export function usableBy(profile: ResolvedProfile, provider: "claude" | "codex" | "grok"): boolean {
  return profile.providers.includes(provider);
}

export interface CodexGroup {
  /** Settings of the process: a change restarts it. */
  readonly key: string;
  readonly profiles: ResolvedProfile[];
  /** Variables of the process (a profile's own). */
  readonly env: Readonly<Record<string, string>>;
  /** The instance's runtime (executable, homes, launch arguments). */
  readonly runtime: ProfileRuntimeConfig;
  /** The instance a process of its own serves. */
  readonly id?: string;
}

export function codexProfileGroup(profileId: string): string {
  return `profile:${profileId}`;
}

/** The provider a command starts work for (admission: turns wait for an install of its CLI). */
export function commandProvider(command: Command): Provider | undefined {
  const kind = command.kind;

  switch (kind.case) {
    case "startTurn":
    case "createThread":
    case "setGoal":
      return kind.value.thread?.provider || undefined;
    case "generateText":
    case "runBotTurn":
      return kind.value.provider || undefined;
    default:
      return undefined;
  }
}

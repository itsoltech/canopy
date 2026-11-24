import { GoalDirective, type ForkSpec, type ThreadSpec, type UserInput } from "@canopy/contracts";
import type { v2 } from "@canopy/codex-protocol";
import { Context, Effect, Layer, Stream } from "effect";
import { decodeJson, jsonObject, jsonString } from "../json.ts";
import { Journal } from "../../journal/index.ts";
import type { ModelInit } from "../models.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import { CodexAppServer, type ServerRequestHandler } from "./app-server.ts";
import type { MentionEntryInit } from "../../mentions/catalog.ts";
import { RpcError } from "./rpc.ts";

import { CodexThreadError, type CodexThreadsOptions, type CodexThreadContext } from "./thread-types.ts";
import { serverRequestHandler } from "./dynamic-tools.ts";
import { threadEvents, threadExit } from "./thread-events.ts";
import { threadCatalog, threadTurnSettings } from "./thread-catalog.ts";
import { threadSessions } from "./thread-sessions.ts";
import { codexConnectorMcp } from "./connector-mcp.ts";
import { codexUsage } from "../usage-limits.ts";
import { codexThreadCommands } from "./thread-commands.ts";
import { verifiedSandbox } from "./sandbox-profile.ts";
import type { RewindThread } from "@canopy/contracts";
import { codexProjectSecretProtection } from "./project-secret-protection.ts";

export { CodexThreadError, type CodexThreadsOptions, type InteractionInit } from "./thread-types.ts";

export {
  codexAgentBusTools,
  codexViewImageTool,
  isViewImageCall,
  CODEX_VIEW_IMAGE_TOOL,
  CODEX_VIEW_IMAGE_NAMESPACE,
} from "./dynamic-tools.ts";

export { withUserMentions } from "./thread-registry.ts";
/**
 * Platform threads on Codex (docs/codex-adapter.md): commands -> app-server requests,
 * notifications -> mapper -> journal (first) -> publish. One registry entry per loaded thread.
 *
 * Every turn notes its rollout in the journal (turn_harness). When the app-server process exits on its own, the
 * turns it ran are settled from their rollouts (providers/reconcile.ts; the end Codex recorded, else failed in the
 * harness: "harness process exited") and the runtime reports failure() so the host starts a new app-server for the
 * next command (docs/durability.md, "Rekoncyliacja z transkryptu harnessu").
 */

export class CodexThreads extends Context.Service<
  CodexThreads,
  {
    readAccount(): Effect.Effect<{ email: string; plan: string } | undefined, CodexThreadError>;
    /** Creates the Codex thread (new or fork) and records thread_ready. Returns the Codex thread id. */
    create(spec: ThreadSpec, fork?: ForkSpec): Effect.Effect<string, CodexThreadError>;
    rewind(request: RewindThread): Effect.Effect<{ providerThreadId?: string }, CodexThreadError>;
    /** Starts a turn; resumes the Codex thread first when this process has not loaded it. */
    startTurn(
      spec: ThreadSpec,
      turnId: string,
      input: UserInput,
      settings?: TurnSettings,
    ): Effect.Effect<string, CodexThreadError>;
    interrupt(threadId: string, turnId: string): Effect.Effect<void, CodexThreadError>;
    /** Adds input to the running turn (turn/steer); idempotent by inputId. */
    steer(
      threadId: string,
      turnId: string,
      inputId: string,
      input: UserInput,
      settings?: Pick<TurnSettings, "serviceTier">,
    ): Effect.Effect<void, SteerError>;
    /** Models a profile offers (model/list, plus the proxy's models for a CLIProxyAPI profile). */
    listModels(profileId: string): Effect.Effect<{ models: ModelInit[]; detail?: string }, CodexThreadError>;
    /** Skills, plugins and apps for the composer in a folder (codex/catalog.ts); refresh = re-scan skills. */
    listMentionCatalog(
      cwd: string,
      refresh: boolean,
    ): Effect.Effect<{ entries: MentionEntryInit[]; notes: string[] }, CodexThreadError>;
    /** Sets, pauses, resumes, completes or clears the thread's Codex goal (docs/goals.md). */
    setGoal(
      spec: ThreadSpec,
      directive: GoalDirective,
      objective: string,
      tokenBudget: bigint,
    ): Effect.Effect<void, CodexThreadError>;
    /** Releases this thread's native work and MCP resources, retaining its durable history. */
    unload(threadId: string): Effect.Effect<void, CodexThreadError>;
    /** Terminates a background process (task id = Codex process id). */
    stopTask(threadId: string, taskId: string): Effect.Effect<void, CodexThreadError>;
    /** Background processes still running, per platform thread. */
    backgroundTasks(): ReadonlyMap<string, readonly string[]>;
    /** Includes turns admitted before their first notification reaches the host. */
    hasActiveTurns(): boolean;
    /** Why this runtime cannot serve any more (its app-server process exited), else undefined. */
    failure(): string | undefined;
    /** The platform thread is loaded in this process (started or resumed here). */
    has(threadId: string): boolean;
  }
>()("canopy/worker/CodexThreads") {
  static readonly layer = (options: CodexThreadsOptions) => {
    // The app-server needs the request handler before the registry exists; route through a reference.
    let route: ServerRequestHandler = async (request) => {
      throw new RpcError(request.method, -32601, "not ready");
    };

    return Layer.effect(
      CodexThreads,
      make(options, (handler) => (route = handler)),
    ).pipe(
      Layer.provide(
        CodexAppServer.layer({
          launch: options.launch,
          clientVersion: options.clientVersion,
          onServerRequest: (request) => route(request),
        }),
      ),
    );
  };
}

const make = (options: CodexThreadsOptions, setRoute: (handler: ServerRequestHandler) => void) =>
  Effect.gen(function* () {
    const codex = yield* CodexAppServer;
    const journal = yield* Journal;

    const projectSecrets = yield* Effect.acquireRelease(
      Effect.try(() => codexProjectSecretProtection(options.launch, codex.userAgent)).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
      (resource) => Effect.promise(() => resource?.close() ?? Promise.resolve()),
    );

    const ctx: CodexThreadContext = {
      options,
      codex,
      journal,
      byPlatform: new Map(),
      byCodex: new Map(),
      mcpSpecs: new Map(),
      failure: undefined,
      ...(projectSecrets && { projectSecrets }),
    };

    const { record } = threadEvents(ctx);
    const usage = trackCodexUsage(ctx);

    ctx.connectorMcp = codexConnectorMcp(ctx);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await ctx.connectorMcp?.close();
      }),
    );
    let processing = 0;
    const settleAfterExit = threadExit(ctx);
    // Interrupted (before the process is killed) when the runtime closes on purpose.
    yield* Effect.forkScoped(
      codex.exited.pipe(
        Effect.tap(() => Effect.promise(() => ctx.projectSecrets?.close() ?? Promise.resolve())),
        Effect.flatMap(settleAfterExit),
        Effect.ignore,
      ),
    );
    // One consumer, in order, for every notification of every loaded thread.
    yield* Effect.forkScoped(
      codex.notifications.pipe(
        Stream.runForEach((notification) => {
          if (notification.method === "account/rateLimits/updated")
            return Effect.sync(() => usage.update(notification.params.rateLimits));

          const threadId = jsonString(jsonObject(decodeJson(notification.params ?? null))?.["threadId"]);
          const entry = threadId ? ctx.byCodex.get(threadId) : undefined;

          if (notification.method === "thread/closed" && entry) {
            ctx.projectSecrets?.reset(entry.platformId);
            entry.onClosed?.();
          }

          if (entry?.sandboxProfile && notification.method === "thread/settings/updated") {
            const { sandboxPolicy, ...settings } = notification.params.threadSettings;

            if (!verifiedSandbox(entry.sandboxProfile, { ...settings, sandbox: sandboxPolicy }))
              entry.sandboxProfileInvalid = true;
          }

          return entry
            ? Effect.acquireUseRelease(
                Effect.sync(() => processing++),
                () => record(entry, notification).pipe(Effect.ignore),
                () =>
                  Effect.sync(() => {
                    processing--;
                    options.onActivitySettled?.();
                  }),
              )
            : Effect.void;
        }),
      ),
    );

    if (options.onUsage) yield* Effect.forkScoped(usage.read);
    setRoute(serverRequestHandler(ctx));

    // Read the launched config so explicit launch flags can override the effort configured in Canopy.
    const instanceEffort = yield* Effect.cached(
      codex.request("config/read", {}).pipe(
        Effect.map((response) => response?.config?.model_reasoning_effort ?? undefined),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      ),
    );

    const catalog = threadCatalog(ctx, instanceEffort);
    const turnSettings = threadTurnSettings(ctx, catalog);
    const sessions = threadSessions(ctx);

    return CodexThreads.of({
      readAccount: usage.readAccount,
      ...codexThreadCommands(ctx, sessions, turnSettings),
      listModels: catalog.listModels,
      listMentionCatalog: catalog.listMentionCatalog,
      backgroundTasks: () =>
        new Map(
          [...ctx.byPlatform.values()].flatMap((entry) =>
            entry.mapper.backgroundTasks.length > 0 ? [[entry.platformId, entry.mapper.backgroundTasks] as const] : [],
          ),
        ),
      hasActiveTurns: () =>
        processing > 0 ||
        [...ctx.byPlatform.values()].some(
          (entry) =>
            entry.pendingTurns.length > 0 ||
            entry.recordingNotifications ||
            [...entry.codexToPlatform.keys()].some((turn) => !entry.finishedTurns.has(turn)),
        ),
      failure: () => ctx.failure,
      has: (threadId) => ctx.byPlatform.has(threadId),
    });
  });

function trackCodexUsage({ codex, options }: CodexThreadContext) {
  let usageRevision = 0;

  const read = Effect.suspend(() => {
    const revision = usageRevision;

    return codex.request("account/rateLimits/read", { excludeResetCreditDetails: true }).pipe(
      Effect.timeout("3 seconds"),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (usageRevision === revision && result.rateLimits) options.onUsage?.(codexUsage(result.rateLimits));
        }),
      ),
      Effect.ignore,
    );
  });

  return {
    read,
    update(rateLimits: v2.AccountRateLimitsUpdatedNotification["rateLimits"]) {
      usageRevision++;
      options.onUsage?.(codexUsage(rateLimits));
    },
    readAccount: () =>
      codex.request("account/read", { refreshToken: false }).pipe(
        Effect.tap(() => {
          usageRevision = 0;

          return options.onUsage ? read : Effect.void;
        }),
        Effect.map((result) =>
          result.account?.type === "chatgpt"
            ? { email: result.account.email ?? "", plan: result.account.planType }
            : undefined,
        ),
        Effect.mapError(
          () =>
            new CodexThreadError({
              threadId: "",
              operation: "account/read",
              message: "Could not read account metadata.",
            }),
        ),
      ),
  };
}

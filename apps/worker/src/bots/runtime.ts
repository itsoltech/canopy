import { workerDiagnostics } from "../diagnostics/worker.ts";
import { Match } from "effect";
import { classifyFailure } from "@canopy/domain";
import {
  Provider,
  TurnEndSource,
  TurnOutcome,
  type BotFileOperation,
  type RunBotTurn,
  type SteerBotTurn,
} from "@canopy/contracts";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { Journal, type ThreadEventInit } from "../journal/index.ts";
import { readHarnessRecord, reconcileEvents } from "../providers/reconcile.ts";
import { CommandError, type CommandOutput } from "../runtime/host-types.ts";
import type { HostContext } from "../runtime/host-context.ts";
import { botSession } from "./session.ts";
import { runClaudeBot } from "./claude.ts";
import { runCodexBot } from "./codex.ts";
import { runGrokBot } from "./grok.ts";
import { BotHarnessFailure } from "./types.ts";
import { botFailureEvent } from "./failures.ts";
import { providersOf, type ResolvedProfile } from "../providers/profiles.ts";
import { botImages } from "./images.ts";
import { botConnectorMcp } from "./connector-mcp.ts";
import { BotFileError, BotWorkspace, cleanupBotWorkspaces } from "./workspace.ts";
import { BotFileOperations } from "./file-operations.ts";
import { BotSteering } from "./steering.ts";

function botProvider(provider: Provider) {
  return Match.value(provider).pipe(
    Match.when(Provider.CLAUDE, () => "claude" as const),
    Match.when(Provider.CODEX, () => "codex" as const),
    Match.when(Provider.GROK, () => "grok" as const),
    Match.orElse(() => undefined),
  );
}

const imagesFor = (ctx: HostContext, input: RunBotTurn) => (resumed: boolean) =>
  botImages(input, resumed, ctx.state.files, (sha) => ctx.ops.fetchBlob(input.botId, sha, input.turnId));

function sessionOptions(
  ctx: HostContext,
  config: AppliedConfig,
  profile: ResolvedProfile,
  provider: "claude" | "codex" | "grok",
) {
  const runtime = profile.runtime;

  const sourceHome = runtime.ownLogin
    ? instanceShadowHome(ctx.state.options.dataDir, provider, profile.id, runtime)!
    : runtime.homePath || ctx.state.deviceHomes[provider] || "";

  return {
    dataDir: ctx.state.options.dataDir,
    sourceHome,
    ...(provider === "claude" &&
      !runtime.ownLogin &&
      !runtime.homePath && {
        secureStorageDir: ctx.state.deviceHomes.claudeSecureStorage ?? sourceHome,
      }),
    linkLogin: profile.kind === "native" && (runtime.ownLogin === true || config[provider].linkDeviceLogin),
  };
}

/** Hidden bot sessions own no project workspace and expose only gateway-executed MCP. */
export class BotTurns {
  readonly #active = new Map<
    string,
    {
      abort: AbortController;
      done: Promise<void>;
      workspace?: BotWorkspace;
      files?: boolean;
      busy?: boolean;
      steering?: BotSteering;
    }
  >();
  readonly #cleanup: ReturnType<typeof setInterval>;
  readonly #files: BotFileOperations;
  constructor(readonly ctx: HostContext) {
    this.#files = new BotFileOperations(ctx.state.options.botDownloads);

    const cleanup = () => {
      try {
        cleanupBotWorkspaces(ctx.state.options.dataDir);
      } catch {
        ctx.ops.log("bots: workspace cleanup failed");
      }
    };

    cleanup();
    this.#cleanup = setInterval(cleanup, 30 * 60 * 1000);
    this.#cleanup.unref();
  }
  async botFile(input: BotFileOperation): Promise<CommandOutput> {
    const turn = this.#active.get(`${input.botId}/${input.turnId}`);

    if (!turn?.files || !turn.workspace || turn.abort.signal.aborted || turn.busy)
      throw new CommandError("BOT_FILES_UNAVAILABLE", "Bot files are unavailable for this turn.", false);
    turn.busy = true;

    try {
      return await this.#files.execute(turn.workspace, input, turn.abort.signal);
    } catch (error) {
      throw new CommandError(
        "BOT_FILE_REFUSED",
        error instanceof BotFileError
          ? error.message
          : "The file is unavailable. Choose a regular file in this conversation workspace.",
        false,
      );
    } finally {
      turn.busy = false;
    }
  }
  async runBotTurn(input: RunBotTurn, commandId: string): Promise<CommandOutput> {
    const key = `${input.botId}/${input.turnId}`;

    if (this.#active.has(key)) return {};

    if ([...this.#active.keys()].some((k) => k.startsWith(`${input.botId}/`)))
      throw new CommandError("BUSY", "Bot already has an active turn", false);
    const abort = new AbortController();
    const closed = Promise.withResolvers<void>();
    // Reserve before the first await: Stop may arrive while journal admission or images are loading.
    this.#active.set(key, { abort, done: closed.promise });

    try {
      return await this.#start(input, commandId, abort, () => {
        this.#active.delete(key);
        closed.resolve();
      });
    } catch (error) {
      this.#active.delete(key);
      closed.resolve();
      throw error;
    }
  }
  async steerBotTurn(input: SteerBotTurn): Promise<CommandOutput> {
    const active = this.#active.get(`${input.botId}/${input.turnId}`);

    const status =
      active &&
      !active.abort.signal.aborted &&
      input.text.trim() &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.inputId)
        ? (active.steering?.submit(input.inputId, input.text) ?? "unsupported")
        : "unsupported";

    return { dataJson: JSON.stringify({ status }) };
  }
  async #start(
    input: RunBotTurn,
    commandId: string,
    abort: AbortController,
    closed: () => void,
  ): Promise<CommandOutput> {
    if (this.ctx.state.closing) throw new CommandError("WORKER_DRAINING", "worker is stopping", false);
    const config = this.ctx.state.config;

    const provider = botProvider(input.provider);

    const status = config?.profiles.find(
      (p) => p.config.id === input.profileId && provider && providersOf(p.config).includes(provider),
    );

    const profile = status?.resolved;

    if (!config || !provider || !profile || !config[provider].enabled)
      throw new CommandError(
        classifyFailure(status?.problem || "provider unavailable"),
        "Bot provider instance is unavailable on this worker",
        true,
      );
    const session = botSession(input, sessionOptions(this.ctx, config, profile, provider));

    const active = this.#active.get(`${input.botId}/${input.turnId}`)!;
    active.workspace = session.workspace;
    active.files = input.files;
    const release = session.workspace.hold();
    const usage = this.ctx.state.usageObservers.get(`${input.provider}/${profile.id}`);

    const record = async (event: ThreadEventInit) => {
      const safeEvent = botFailureEvent(usage?.failure(event) ?? event);

      const saved = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.append(input.botId, { ...safeEvent, turnId: input.turnId })),
      );

      this.ctx.ops.publish(saved);

      if (safeEvent.body?.case === "turnFinished" && safeEvent.body.value.outcome === TurnOutcome.FAILED)
        this.ctx.ops.log(
          `bots: turn failed source harness class ${classifyFailure("", safeEvent.body.value.errorClass)}`,
        );
    };

    const bus = botConnectorMcp(this.ctx.ops, input, abort.signal);

    try {
      const started = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.admitBotTurn(commandId, input.botId, input.turnId)),
      );

      if (!started) {
        release();
        bus.close();
        closed();

        return {};
      }

      this.ctx.state.threadProviders.set(input.botId, input.provider);
      this.ctx.ops.publish(started);
    } catch (error) {
      release();
      bus.close();
      throw error;
    }

    const steering = provider === "grok" ? undefined : new BotSteering(session, record);

    if (steering) active.steering = steering;

    const context = {
      pricing: this.ctx.state.pricing,
      ...(steering && { steering }),
      onUsage: usage?.report,
      usageSnapshot: this.ctx.state.usage.get(`${input.provider}/${profile.id}`)?.snapshot,
      input,
      session,
      profile,
      signal: abort.signal,
      executable: profile.runtime.executablePath || config[provider].executable || provider,
      clientVersion: this.ctx.state.options.clientVersion,
      mcp:
        "url" in bus.server
          ? { url: bus.server.url, headers: Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value])) }
          : { url: "", headers: {} },
      record,
      content: imagesFor(this.ctx, input),
      noteHarness: (harness: Parameters<Journal["Service"]["noteHarness"]>[2]) =>
        this.ctx.state.options.runtime.runPromise(
          Journal.use((j) => j.noteHarness(input.botId, input.turnId, harness)),
        ),
    };

    workerDiagnostics.turns.begin(input.botId, input.turnId, provider);
    void Match.value(provider)
      .pipe(
        Match.when("claude", () => runClaudeBot(context)),
        Match.when("codex", () => runCodexBot(context)),
        Match.when("grok", () => runGrokBot(context)),
        Match.exhaustive,
      )
      .then(
        async () => {
          await steering?.close();
          await record({
            body: {
              case: "turnFinished",
              value: { outcome: abort.signal.aborted ? TurnOutcome.INTERRUPTED : TurnOutcome.COMPLETED },
            },
          });
        },
        async (error) => {
          await steering?.close();
          await this.#failed(
            input,
            abort.signal.aborted,
            record,
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      )
      .catch(() => this.ctx.ops.log("bots: harness journal failed"))
      .finally(() => {
        this.#files.drop(input.botId);
        release();
        workerDiagnostics.turns.finish(input.botId, input.turnId, true);
        abort.abort();
        bus.close();
        closed();
      });

    return {};
  }
  async #failed(input: RunBotTurn, aborted: boolean, record: (event: ThreadEventInit) => Promise<void>, error: Error) {
    const open = (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.openTurns()))).find(
      (t) => t.turnId === input.turnId && t.threadId === input.botId,
    );

    if (!open) return;
    // Use the same transcript readers and end codes as project thread turns.
    const transcript = await readHarnessRecord(open);

    const reconciled = reconcileEvents(open, transcript, {
      outcome: aborted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED,
      source: aborted ? TurnEndSource.SYSTEM : TurnEndSource.HARNESS,
      reason: aborted ? "Bot turn interrupted" : error.message,
      errorCode: aborted ? "" : error instanceof BotHarnessFailure ? error.code : classifyFailure(error.message),
    });

    for (const event of reconciled) await record(event);
  }
  async interruptBotTurn(input: { threadId: string; turnId: string }): Promise<CommandOutput> {
    await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.noteInterrupt(input.threadId, input.turnId)));
    const active = this.#active.get(`${input.threadId}/${input.turnId}`);
    active?.abort.abort();
    await active?.done;

    return {};
  }
  async closeBots(): Promise<void> {
    clearInterval(this.#cleanup);
    const active = [...this.#active.values()];

    for (const task of active) task.abort.abort();
    await Promise.allSettled(active.map((t) => t.done));
  }
}

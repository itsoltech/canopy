import { create } from "@bufbuild/protobuf";
import { Match } from "effect";
import { AgentToolCallSchema, Provider, TurnEndSource, TurnOutcome, type RunBotTurn } from "@canopy/contracts";
import { instanceShadowHome } from "../config/remote.ts";
import { Journal, type ThreadEventInit } from "../journal/index.ts";
import { grokBus } from "../providers/grok/bus.ts";
import { reconcileTurn } from "../providers/reconcile.ts";
import { CommandError, usableBy, type CommandOutput } from "../runtime/host-types.ts";
import type { HostContext } from "../runtime/host-context.ts";
import { botSession } from "./session.ts";
import { runClaudeBot } from "./claude.ts";
import { runCodexBot } from "./codex.ts";
import { runGrokBot } from "./grok.ts";
import { BotHarnessFailure } from "./types.ts";

/** Hidden bot sessions own no project workspace and expose only gateway-executed MCP. */
export class BotTurns {
  readonly #active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(readonly ctx: HostContext) {}
  async runBotTurn(input: RunBotTurn, commandId: string): Promise<CommandOutput> {
    if (this.ctx.state.closing) throw new CommandError("WORKER_DRAINING", "worker is stopping", false);
    const config = this.ctx.state.config;

    const provider =
      input.provider === Provider.CLAUDE
        ? "claude"
        : input.provider === Provider.CODEX
          ? "codex"
          : input.provider === Provider.GROK
            ? "grok"
            : undefined;

    const profile = config?.profiles.find(
      (p) => p.resolved?.id === input.profileId && provider && usableBy(p.resolved, provider),
    )?.resolved;

    if (!config || !provider || !profile || !config[provider].enabled)
      throw new CommandError("PROVIDER_UNAVAILABLE", "Bot provider instance is unavailable on this worker", true);
    const key = `${input.botId}/${input.turnId}`;

    if (this.#active.has(key)) return {};

    if ([...this.#active.keys()].some((k) => k.startsWith(`${input.botId}/`)))
      throw new CommandError("BUSY", "Bot already has an active turn", false);
    const runtime = profile.runtime ?? {};

    const sourceHome = runtime.ownLogin
      ? instanceShadowHome(this.ctx.state.options.dataDir, provider, profile.id, runtime)!
      : runtime.homePath || this.ctx.state.deviceHomes[provider] || "";

    const session = botSession(input, {
      dataDir: this.ctx.state.options.dataDir,
      sourceHome,
      linkLogin: profile.kind === "native" && (runtime.ownLogin === true || config[provider].linkDeviceLogin),
    });

    const abort = new AbortController();

    const record = async (event: ThreadEventInit) => {
      const saved = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.append(input.botId, { ...event, turnId: input.turnId })),
      );

      this.ctx.ops.publish(saved);
    };

    const bus = grokBus({
      threadId: input.botId,
      depth: 0,
      agentBus: false,
      connectorTools: input.tools,
      turnId: () => input.turnId,
      callTool: (call) =>
        this.ctx.ops.callTool(create(AgentToolCallSchema, { ...call, botId: input.botId }), abort.signal),
    });

    try {
      const started = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.admitBotTurn(commandId, input.botId, input.turnId)),
      );

      if (!started) {
        bus.close();

        return {};
      }

      this.ctx.state.threadProviders.set(input.botId, input.provider);
      this.ctx.ops.publish(started);
    } catch (error) {
      bus.close();
      throw error;
    }

    const context = {
      input,
      session,
      profile,
      signal: abort.signal,
      executable: runtime.executablePath || config[provider].executable || provider,
      clientVersion: this.ctx.state.options.clientVersion,
      mcp:
        "url" in bus.server
          ? { url: bus.server.url, headers: Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value])) }
          : { url: "", headers: {} },
      record,
      noteHarness: (harness: Parameters<Journal["Service"]["noteHarness"]>[2]) =>
        this.ctx.state.options.runtime.runPromise(
          Journal.use((j) => j.noteHarness(input.botId, input.turnId, harness)),
        ),
    };

    const done = Match.value(provider)
      .pipe(
        Match.when("claude", () => runClaudeBot(context)),
        Match.when("codex", () => runCodexBot(context)),
        Match.when("grok", () => runGrokBot(context)),
        Match.exhaustive,
      )
      .then(
        () => record({ body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } } }),
        async (error) => {
          const open = (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.openTurns()))).find(
            (t) => t.turnId === input.turnId && t.threadId === input.botId,
          );

          if (!open) return;

          // Use the same transcript readers and end codes as project thread turns.
          const reconciled = await this.ctx.state.options.runtime.runPromise(
            reconcileTurn(open, {
              outcome: abort.signal.aborted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED,
              source: abort.signal.aborted ? TurnEndSource.SYSTEM : TurnEndSource.HARNESS,
              reason: abort.signal.aborted ? "Bot turn interrupted" : "Bot harness could not finish this turn",
              errorCode: abort.signal.aborted ? "" : error instanceof BotHarnessFailure ? error.code : "HARNESS_ERROR",
            }),
          );

          for (const event of reconciled.events) this.ctx.ops.publish(event);
        },
      )
      .catch(() => this.ctx.ops.log("bots: harness journal failed"))
      .finally(() => {
        bus.close();
        this.#active.delete(key);
      });

    this.#active.set(key, { abort, done });

    return {};
  }
  async interruptBotTurn(input: { threadId: string; turnId: string }): Promise<CommandOutput> {
    await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.noteInterrupt(input.threadId, input.turnId)));
    this.#active.get(`${input.threadId}/${input.turnId}`)?.abort.abort();

    return {};
  }
  async closeBots(): Promise<void> {
    const active = [...this.#active.values()];

    for (const task of active) task.abort.abort();
    await Promise.allSettled(active.map((t) => t.done));
  }
}

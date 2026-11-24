import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit } from "effect";
import { CodexAppServer } from "../providers/codex/app-server.ts";
import { codexAppServerLaunch, codexThreadProvider, type CodexAppServerLaunch } from "../providers/codex/launch.ts";
import { codexTextOverrides } from "../providers/generate-text.ts";
import { codexBotCatalog, codexModelEntry } from "./codex-catalog.ts";
import type { BotHarnessContext } from "./types.ts";
import { BotHarnessFailure } from "./types.ts";
import { CodexConsumedUsage } from "../providers/codex/consumed-usage.ts";
import { isolatedHomeEnvironment } from "../providers/home.ts";
import { verifyCodexBotTier } from "./codex-service-tier.ts";
import { codexBotEvents } from "./codex-events.ts";
import { codexBotAuth } from "./codex-auth.ts";

async function botCodexLaunch(ctx: BotHarnessContext): Promise<CodexAppServerLaunch> {
  const { input, session } = ctx;

  const launch = codexAppServerLaunch(
    [ctx.profile],
    process.env,
    ctx.executable,
    undefined,
    session.home,
    ctx.profile.env,
    // Bot isolation owns CLI configuration; instance launch flags may enable local tools or MCP servers.
    [],
  );

  const env: NodeJS.ProcessEnv = { ...launch.env, ...isolatedHomeEnvironment(session.home, launch.env) };

  if (session.codexSqliteHome !== undefined) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CODEX_SQLITE_HOME") delete env[key];
    // The model catalog probe does not inherit app-server arguments.
    env["CODEX_SQLITE_HOME"] = session.codexSqliteHome;
  }

  if (ctx.profile.kind === "native" && session.linkLogin) {
    // The selected profile resolves environment credentials too. Only its approved RPC result enters the bot.
    for (const key of Object.keys(env))
      if (["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"].includes(key.toUpperCase())) delete env[key];
  }

  const base = { ...launch, env };
  const catalog = join(session.home, "bot-model.json");
  const entry = await codexModelEntry(base, input.model);
  writeFileSync(catalog, JSON.stringify(codexBotCatalog(input.model, input.effort, entry)), { mode: 0o600 });

  return {
    ...base,
    command: [
      ...base.command,
      ...(session.codexSqliteHome && session.codexSqliteHome !== session.home
        ? ["-c", `sqlite_home=${JSON.stringify(session.codexSqliteHome)}`]
        : []),
      ...codexTextOverrides(catalog),
      "-c",
      `web_search=${JSON.stringify(input.webAccess ? "live" : "disabled")}`,
      "-c",
      'cli_auth_credentials_store="ephemeral"',
      "-c",
      "skills.include_instructions=false",
      "-c",
      "skills.bundled.enabled=false",
      "-c",
      "features.skip_host_skill_discovery=true",
    ],
  };
}

function botThreadParams(ctx: BotHarnessContext) {
  return {
    model: ctx.input.model,
    serviceTier: ctx.input.serviceTier || "default",
    ...codexThreadProvider(ctx.profile),
    cwd: ctx.session.cwd,
    approvalPolicy: "never" as const,
    sandbox: "read-only" as const,
    baseInstructions: ctx.input.instructions,
    developerInstructions: "",
    config: {
      project_doc_max_bytes: 0,
      // Only this authenticated server delegates authorization to the gateway. Keep native tools denied.
      mcp_servers: ctx.input.tools.length
        ? { canopy: { url: ctx.mcp.url, http_headers: ctx.mcp.headers, default_tools_approval_mode: "approve" } }
        : {},
      developer_instructions: "",
      web_search: ctx.input.webAccess ? "live" : "disabled",
    },
  };
}

async function imageInput(ctx: BotHarnessContext, resumed: boolean) {
  const content = await ctx.content(resumed);

  return [
    { type: "text" as const, text: content.text, text_elements: [] },
    ...content.images.map((image) => ({
      type: "image" as const,
      url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
    })),
  ];
}

/** Dedicated official app-server; the bot catalog keeps the model's limits and removes every local tool. */
function codexBotProgram(ctx: BotHarnessContext, launch: CodexAppServerLaunch) {
  const { input, session } = ctx;
  const auth = codexBotAuth(ctx);

  const program = Effect.gen(function* () {
    const server = yield* CodexAppServer;
    yield* auth.login(server);
    yield* verifyCodexBotTier(server, input.model, input.serviceTier);
    const done = yield* Deferred.make<void, Error>();
    yield* Effect.forkScoped(
      server.exited.pipe(Effect.flatMap(() => Deferred.fail(done, new BotHarnessFailure("process_exit")))),
    );
    const native = { id: "", turn: "", completed: false };
    const consumed = new CodexConsumedUsage(ctx.pricing);
    consumed.setModel(input.model);
    consumed.setRequestedServiceTier(input.serviceTier || "default");
    yield* Effect.forkScoped(codexBotEvents(ctx, server, done, native, consumed));

    const params = botThreadParams(ctx);

    const resumed = session.id
      ? yield* server
          .request("thread/resume", { threadId: session.id, ...params, excludeTurns: true })
          .pipe(
            Effect.catch((error) =>
              /no rollout found|not found|session missing/i.test(error.message)
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          )
      : undefined;

    const started =
      resumed ??
      (yield* server.request("thread/start", {
        ...params,
        ephemeral: false,
        experimentalRawEvents: true,
        dynamicTools: [],
        environments: [],
      }));

    const id = started.thread.id;
    native.id = id;
    session.save(id);
    const path = started.thread.path || "";

    const offset = path
      ? (() => {
          try {
            return statSync(path).size;
          } catch {
            return 0;
          }
        })()
      : 0;

    yield* Effect.promise(() =>
      ctx.noteHarness({ harness: "codex", transcript: path, sessionId: id, offset, providerTurn: "" }),
    );

    const turn = yield* server.request("turn/start", {
      threadId: id,
      serviceTier: input.serviceTier || "default",
      input: yield* Effect.promise(() => imageInput(ctx, Boolean(resumed))),
      ...(input.effort && { effort: input.effort }),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });

    native.turn = turn.turn.id;

    yield* Effect.promise(() =>
      ctx.noteHarness({ harness: "codex", transcript: path, sessionId: id, offset, providerTurn: turn.turn.id }),
    );
    ctx.steering?.ready(async (inputId, text) => {
      if (native.completed || ctx.signal.aborted) throw new Error("Bot turn ended");
      await Effect.runPromise(
        server.request("turn/steer", {
          threadId: id,
          expectedTurnId: native.turn,
          clientUserMessageId: inputId,
          input: [{ type: "text", text, text_elements: [] }],
        }),
        { signal: ctx.signal },
      );
    });
    yield* Deferred.await(done);
  }).pipe(
    Effect.provide(
      CodexAppServer.layer({
        launch,
        clientVersion: ctx.clientVersion,
        onServerRequest: auth.onServerRequest,
      }),
    ),
    Effect.scoped,
  );

  return program;
}

export async function runCodexBot(ctx: BotHarnessContext): Promise<void> {
  ctx = { ...ctx, input: { ...ctx.input } };
  ctx.signal.throwIfAborted();
  const exit = await Effect.runPromiseExit(codexBotProgram(ctx, await botCodexLaunch(ctx)), { signal: ctx.signal });

  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

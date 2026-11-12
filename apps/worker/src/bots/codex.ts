import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Stream } from "effect";
import { ItemDeltaField, ItemStatus } from "@canopy/contracts";
import { CodexAppServer } from "../providers/codex/app-server.ts";
import { codexAppServerLaunch, codexThreadProvider, type CodexAppServerLaunch } from "../providers/codex/launch.ts";
import { codexTextOverrides } from "../providers/generate-text.ts";
import { codexBotCatalog, codexModelEntry } from "./codex-catalog.ts";
import type { BotHarnessContext } from "./types.ts";
import { BotHarnessFailure } from "./types.ts";
import { codexErrorCode } from "../providers/codex/status-mapping.ts";
import { decodeJson } from "../providers/json.ts";
import { isolatedHomeEnvironment } from "../providers/home.ts";
import { rejectBotToolApproval } from "./failures.ts";

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

  const base = { ...launch, env: { ...launch.env, ...isolatedHomeEnvironment(session.home) } };
  const catalog = join(session.home, "bot-model.json");
  const entry = await codexModelEntry(base, input.model);
  writeFileSync(catalog, JSON.stringify(codexBotCatalog(input.model, input.effort, entry)), { mode: 0o600 });

  return {
    ...base,
    command: [
      ...base.command,
      ...codexTextOverrides(catalog),
      "-c",
      `web_search=${JSON.stringify(input.webAccess ? "live" : "disabled")}`,
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "skills.include_instructions=false",
      "-c",
      "skills.bundled.enabled=false",
      "-c",
      "features.skip_host_skill_discovery=true",
    ],
  };
}

function codexFailure(error: import("@canopy/codex-protocol").v2.TurnError | null | undefined) {
  return new BotHarnessFailure(codexErrorCode(decodeJson(error?.codexErrorInfo)) || "HARNESS_ERROR", error?.message);
}

function botThreadParams(ctx: BotHarnessContext) {
  return {
    model: ctx.input.model,
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

  const program = Effect.gen(function* () {
    const server = yield* CodexAppServer;
    const done = yield* Deferred.make<void, Error>();
    yield* Effect.forkScoped(
      server.exited.pipe(Effect.flatMap(() => Deferred.fail(done, new BotHarnessFailure("process_exit")))),
    );
    let id = "";
    yield* Effect.forkScoped(
      server.notifications.pipe(
        Stream.runForEach((event) => {
          if (!("threadId" in event.params) || event.params.threadId !== id) return Effect.void;

          if (
            event.method === "item/completed" &&
            event.params.item.type === "mcpToolCall" &&
            event.params.item.server === "canopy" &&
            /MCP tool call requires approval|approval required.*approval policy.*never/i.test(
              event.params.item.error?.message ?? "",
            )
          )
            return Effect.tryPromise({
              try: () => rejectBotToolApproval(ctx),
              catch: () => new BotHarnessFailure("tool_approval"),
            }).pipe(Effect.catch((error) => Deferred.fail(done, error)));

          if (event.method === "item/agentMessage/delta")
            return Effect.promise(() =>
              ctx.record({
                body: {
                  case: "itemDelta",
                  value: { itemId: event.params.itemId, field: ItemDeltaField.TEXT, chunk: event.params.delta },
                },
              }),
            );

          if (event.method === "item/completed" && event.params.item.type === "agentMessage") {
            const item = event.params.item;

            return Effect.promise(() =>
              ctx.record({
                body: {
                  case: "itemCompleted",
                  value: {
                    item: {
                      itemId: item.id,
                      status: ItemStatus.COMPLETED,
                      content: { case: "agentMessage", value: { text: item.text } },
                    },
                  },
                },
              }),
            );
          }

          if (event.method === "turn/completed")
            return event.params.turn.status === "completed"
              ? Deferred.succeed(done, undefined)
              : Deferred.fail(done, codexFailure(event.params.turn.error));

          return Effect.void;
        }),
      ),
    );

    const params = botThreadParams(ctx);

    const resumed = session.id
      ? yield* server
          .request("thread/resume", { threadId: session.id, ...params })
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
      (yield* server.request("thread/start", { ...params, ephemeral: false, dynamicTools: [], environments: [] }));

    id = started.thread.id;
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
      input: yield* Effect.promise(() => imageInput(ctx, Boolean(resumed))),
      ...(input.effort && { effort: input.effort }),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });

    yield* Effect.promise(() =>
      ctx.noteHarness({ harness: "codex", transcript: path, sessionId: id, offset, providerTurn: turn.turn.id }),
    );
    yield* Deferred.await(done);
  }).pipe(
    Effect.provide(
      CodexAppServer.layer({
        launch,
        clientVersion: ctx.clientVersion,
        onServerRequest: async () => {
          throw new Error("Bots have no native tools or interactions");
        },
      }),
    ),
    Effect.scoped,
  );

  return program;
}

export async function runCodexBot(ctx: BotHarnessContext): Promise<void> {
  ctx.signal.throwIfAborted();
  const exit = await Effect.runPromiseExit(codexBotProgram(ctx, await botCodexLaunch(ctx)), { signal: ctx.signal });

  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

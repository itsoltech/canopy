import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Effect } from "effect";
import type { ThreadSpec } from "@canopy/contracts";
import { sourceStat } from "../../import/read.ts";
import { CodexAppServer } from "./app-server.ts";
import { RpcError } from "./rpc.ts";
import { nativeRollout } from "./recovery-rollout.ts";
import { fail, type CodexThreadContext, type Entry } from "./thread-types.ts";

export const noRollout = /no rollout found/i;

const pathError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

export const importedPath = (ctx: CodexThreadContext, spec: ThreadSpec, modelProvider: string) =>
  Effect.try({
    try: () => ctx.options.importedResumePath?.(spec, modelProvider),
    catch: (cause) => fail(spec.threadId, "resume")(pathError(cause)),
  });

/** Bind new CLI rollouts before their native IDs are published to the gateway. */
export function rememberCliHome(ctx: CodexThreadContext, spec: ThreadSpec, id: string) {
  if (!ctx.options.previousPrivateHome) return Effect.void;

  return Effect.gen(function* () {
    const home = yield* Effect.try(() => realpathSync(ctx.options.launch.env["CODEX_HOME"]!));
    yield* ctx.journal.rememberCodexCliHome(id, home);
  }).pipe(Effect.mapError(fail(spec.threadId, "journal")));
}

/** Resolve the selected native rollout through Codex, including its paginated history index. */
function readPath(server: CodexAppServer["Service"], id: string) {
  return server.request("thread/read", { threadId: id }).pipe(
    Effect.map((response) => response.thread?.path),
    Effect.catch((error) =>
      noRollout.test(error.message) || error.message.includes(`thread not loaded: ${id}`)
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
}

function verifiedPath(home: string, path: string, id: string) {
  const root = realpathSync(home);
  const native = nativeRollout(path, id);

  if (!native || relative(root, realpathSync(native.home)) !== "")
    throw new Error("The selected Codex rollout is outside its session home.");
  // Codex reports the plain name even for compressed history.
  const plain = join(root, relative(native.home, path)).replace(/\.zst$/, "");
  const file = existsSync(plain) ? plain : `${plain}.zst`;

  if (sourceStat({ root, path: file }).nlink !== 1) throw new Error("The selected Codex rollout has multiple links.");

  return file;
}

/** Unarchive is scoped to the process's sessions directory, including for rollouts from before direct CLI mode. */
function privateStore<A, E>(
  ctx: CodexThreadContext,
  home: string,
  use: (server: CodexAppServer["Service"]) => Effect.Effect<A, E>,
) {
  const { launch, clientVersion } = ctx.options;

  return CodexAppServer.use(use).pipe(
    Effect.provide(
      CodexAppServer.layer({
        launch: {
          command: [
            ...launch.command,
            "-c",
            'cli_auth_credentials_store="ephemeral"',
            "-c",
            "features.plugins=false",
            "-c",
            "features.hooks=false",
          ],
          env: { ...launch.env, CODEX_HOME: home },
        },
        clientVersion,
        onServerRequest: async (request) => {
          throw new RpcError(request.method, -32601, "Only thread storage requests are supported.");
        },
      }),
    ),
  );
}

/** Path is needed only when the selected rollout is outside the active home. */
export function previousRollout(ctx: CodexThreadContext, spec: ThreadSpec, id: string, provider: string) {
  return Effect.gen(function* () {
    const previous = ctx.options.previousPrivateHome;
    const bound = yield* ctx.journal.codexCliHome(id);

    if (!previous && !bound) return undefined;

    const cli = ctx.options.launch.env["CODEX_HOME"];
    const activeHome = cli && (yield* Effect.try({ try: () => realpathSync(cli), catch: pathError }));

    if (!previous || !activeHome || (bound && relative(bound, activeHome) !== ""))
      return yield* Effect.fail(new Error("Select the CLI home that contains this Codex thread to continue it."));

    // A manifest can describe a masked private copy with the same ID as the CLI original.
    yield* importedPath(ctx, { ...spec, providerThreadId: id }, provider);

    const verify = (home: string, candidate: string) =>
      Effect.try({ try: () => verifiedPath(home, candidate, id), catch: pathError });

    let path = yield* readPath(ctx.codex, id);

    if (bound) {
      if (path) yield* verify(bound, path);

      return undefined;
    }

    // Older installations may have a rollout that is absent from Codex's SQLite index.
    if (!path && (existsSync(join(previous, "sessions")) || existsSync(join(previous, "archived_sessions"))))
      path = yield* privateStore(ctx, previous, (server) => readPath(server, id));

    if (!path) return undefined;
    const checked = yield* verify(previous, path);

    if (basename(dirname(checked)) !== "archived_sessions") return checked;

    const restored = yield* privateStore(ctx, previous, (server) =>
      server.request("thread/unarchive", { threadId: id }),
    );

    if (!restored.thread.path) return yield* Effect.fail(new Error("Codex did not restore the private rollout."));

    return yield* verify(previous, restored.thread.path);
  }).pipe(Effect.mapError(fail(spec.threadId, "resume")));
}

/** Outside the app-server's home, archive cannot move the rollout. Wait for native idle unload on unsubscribe. */
export function unsubscribeThread(ctx: CodexThreadContext, entry: Entry) {
  return Effect.gen(function* () {
    const closed = entry.privateRollout ? Promise.withResolvers<void>() : undefined;

    if (closed) entry.onClosed = closed.resolve;

    try {
      const result = yield* ctx.codex.request("thread/unsubscribe", { threadId: entry.codexId });

      if (closed && result.status !== "notLoaded")
        yield* Effect.promise(() => closed.promise).pipe(Effect.timeout("15 seconds"));
    } finally {
      delete entry.onClosed;
    }
  }).pipe(Effect.mapError(fail(entry.platformId, "unsubscribe")));
}

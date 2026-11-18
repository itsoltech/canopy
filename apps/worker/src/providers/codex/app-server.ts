import type { InitializeParams, ServerNotification, ServerRequest, v2 } from "@canopy/codex-protocol";
import { Context, Effect, Layer, Option, Predicate, PubSub, Schema, Stream } from "effect";
import { governBunSpawn, windowsCommand } from "@canopy/process-governor";
import type { JsonValue } from "@canopy/domain";
import { decodeJson } from "../json.ts";
import type { CodexAppServerLaunch } from "./launch.ts";
import { JsonRpcPeer, RpcError, readLines } from "./rpc.ts";

/**
 * One long-lived `codex app-server` process per worker (docs/execution.md).
 * Typed requests for the methods the adapter uses, a stream of server notifications for all
 * threads, and server requests (approvals, user input, dynamic tool calls) handed to the caller.
 */

export class CodexAppServerError extends Schema.TaggedError<CodexAppServerError>()("CodexAppServerError", {
  method: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.Number),
}) {}

export class CodexAppServerStartupError extends Schema.TaggedError<CodexAppServerStartupError>()(
  "CodexAppServerStartupError",
  { message: Schema.String },
) {}

/** Requests the adapter uses, with their params and results (bindings from the pinned Codex version). */
export interface CodexMethods {
  "account/rateLimits/read": { params: v2.GetAccountRateLimitsParams; result: v2.GetAccountRateLimitsResponse };
  "mcpServerStatus/list": { params: v2.ListMcpServerStatusParams; result: v2.ListMcpServerStatusResponse };
  "account/read": { params: v2.GetAccountParams; result: v2.GetAccountResponse };
  "thread/start": { params: v2.ThreadStartParams; result: v2.ThreadStartResponse };
  "thread/resume": { params: v2.ThreadResumeParams; result: v2.ThreadResumeResponse };
  "thread/inject_items": { params: v2.ThreadInjectItemsParams; result: v2.ThreadInjectItemsResponse };
  "thread/fork": { params: v2.ThreadForkParams; result: v2.ThreadForkResponse };
  "thread/archive": { params: v2.ThreadArchiveParams; result: v2.ThreadArchiveResponse };
  "thread/unarchive": { params: v2.ThreadUnarchiveParams; result: v2.ThreadUnarchiveResponse };
  "thread/backgroundTerminals/clean": {
    params: v2.ThreadBackgroundTerminalsCleanParams;
    result: v2.ThreadBackgroundTerminalsCleanResponse;
  };
  "thread/unsubscribe": { params: v2.ThreadUnsubscribeParams; result: v2.ThreadUnsubscribeResponse };
  "turn/start": { params: v2.TurnStartParams; result: v2.TurnStartResponse };
  "turn/steer": { params: v2.TurnSteerParams; result: v2.TurnSteerResponse };
  "turn/interrupt": { params: v2.TurnInterruptParams; result: v2.TurnInterruptResponse };
  "thread/goal/set": { params: v2.ThreadGoalSetParams; result: v2.ThreadGoalSetResponse };
  "thread/goal/get": { params: v2.ThreadGoalGetParams; result: v2.ThreadGoalGetResponse };
  "thread/goal/clear": { params: v2.ThreadGoalClearParams; result: v2.ThreadGoalClearResponse };
  "model/list": { params: v2.ModelListParams; result: v2.ModelListResponse };
  "thread/backgroundTerminals/list": {
    params: v2.ThreadBackgroundTerminalsListParams;
    result: v2.ThreadBackgroundTerminalsListResponse;
  };
  "thread/backgroundTerminals/terminate": {
    params: v2.ThreadBackgroundTerminalsTerminateParams;
    result: v2.ThreadBackgroundTerminalsTerminateResponse;
  };
  "account/login/start": { params: v2.LoginAccountParams; result: v2.LoginAccountResponse };
  "skills/list": { params: v2.SkillsListParams; result: v2.SkillsListResponse };
  "plugin/list": { params: v2.PluginListParams; result: v2.PluginListResponse };
  "app/list": { params: v2.AppsListParams; result: v2.AppsListResponse };
}

/** Answers a server request (approval, user input, dynamic tool call). Throw RpcError to answer with an error. */
type RequestWithoutId<R> = R extends ServerRequest ? Omit<R, "id"> : never;

export type ServerRequestHandler = (request: RequestWithoutId<ServerRequest>) => Promise<JsonValue>;

export interface CodexAppServerOptions {
  readonly launch: CodexAppServerLaunch;
  readonly onServerRequest: ServerRequestHandler;
  readonly clientName?: string;
  readonly clientVersion: string;
}

export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    /** e.g. "canopy-worker/0.164.0 (Linux ...)"; the Codex version is the first version in it. */
    readonly userAgent: string;
    request<M extends keyof CodexMethods>(
      method: M,
      params: CodexMethods[M]["params"],
    ): Effect.Effect<CodexMethods[M]["result"], CodexAppServerError>;
    /** Every server notification, for all threads. Subscribe before triggering the work you want to observe. */
    readonly notifications: Stream.Stream<ServerNotification>;
    /** Last stderr lines of the process, for diagnostics. */
    stderrTail(): string;
    /** Completes with the exit code when the process ends (crash, kill); never while it runs. */
    readonly exited: Effect.Effect<number | null>;
  }
>()("canopy/worker/CodexAppServer") {
  static readonly layer = (options: CodexAppServerOptions) =>
    Layer.effect(
      CodexAppServer,
      Effect.gen(function* () {
        const notifications = yield* PubSub.unbounded<ServerNotification>();
        const stderr: string[] = [];

        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const command = windowsCommand(options.launch.command, options.launch.env);

              return governBunSpawn("harness", () =>
                Bun.spawn([...command.argv], {
                  env: options.launch.env,
                  windowsVerbatimArguments: command.windowsVerbatimArguments,
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              );
            },
            catch: () => new CodexAppServerStartupError({ message: "Could not spawn the Codex app-server." }),
          }),
          (proc) =>
            Effect.promise(async () => {
              proc.stdin.end();
              proc.kill();
              await proc.exited;
            }),
        );

        yield* Effect.forkScoped(
          Effect.promise(async () => {
            for await (const line of readLines(proc.stderr)) {
              stderr.push(line);

              if (stderr.length > 200) stderr.shift();
            }
          }),
        );

        const peer = new JsonRpcPeer(
          {
            write: (line) => {
              proc.stdin.write(line);
              proc.stdin.flush();
            },
            lines: readLines(proc.stdout),
          },
          {
            onNotification: (method, params) => {
              // SAFETY: The JSON-RPC envelope is decoded by the peer; the configured Codex process owns
              // the method/params correlation described by the pinned generated protocol bindings.
              const notification = { method, params } as ServerNotification;
              Effect.runSync(PubSub.publish(notifications, notification));
            },
            onRequest: (method, params) => {
              // SAFETY: Requests come only from this Codex process after the peer decoded their JSON envelope;
              // the generated union describes its method/params correlation, checked again by the request handler.
              const request = { method, params } as RequestWithoutId<ServerRequest>;

              return options.onServerRequest(request);
            },
          },
        );

        yield* Effect.forkScoped(Effect.promise(() => peer.run()));

        const call = (method: string, params: InitializeParams | CodexMethods[keyof CodexMethods]["params"]) =>
          Effect.tryPromise({
            try: () => peer.request(method, decodeJson(JSON.parse(JSON.stringify(params)))),
            catch: (error) =>
              new CodexAppServerError({
                method,
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof RpcError && { code: error.code }),
              }),
          });

        const initializeParams: InitializeParams = {
          clientInfo: { name: options.clientName ?? "canopy-worker", title: null, version: options.clientVersion },
          // experimentalApi: dynamicTools (agent bus) and other experimental fields.
          capabilities: { experimentalApi: true, requestAttestation: false },
        };

        const initialized = yield* call("initialize", initializeParams).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ userAgent: Schema.String }))),
          Effect.catch((error) =>
            Effect.gen(function* () {
              // The RPC pipe can close before Bun reports the process exit.
              const exit =
                proc.exitCode ??
                Option.getOrUndefined(
                  yield* Effect.promise(() => proc.exited).pipe(Effect.timeoutOption("100 millis")),
                );

              const message =
                exit !== undefined
                  ? `Codex app-server exited during initialization (code ${exit}).`
                  : Predicate.isTagged(error, "TimeoutError")
                    ? "Codex app-server initialization timed out."
                    : "Codex app-server initialization failed.";

              return yield* new CodexAppServerStartupError({ message });
            }),
          ),
        );

        peer.notify("initialized");

        return CodexAppServer.of({
          userAgent: initialized.userAgent,
          request: <M extends keyof CodexMethods>(method: M, params: CodexMethods[M]["params"]) =>
            call(method, params).pipe(
              Effect.map((result) => {
                // SAFETY: JsonRpcPeer correlates this response id with the requested method. The configured
                // Codex process supplies that method's result from the pinned generated protocol contract.
                return result as CodexMethods[M]["result"];
              }),
            ),
          notifications: Stream.fromPubSub(notifications),
          stderrTail: () => stderr.slice(-50).join("\n"),
          exited: Effect.promise(() => proc.exited),
        });
      }),
    );
}

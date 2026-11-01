import type { InitializeParams, InitializeResponse, ServerNotification, ServerRequest, v2 } from "@open-agents/codex-protocol";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
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

/** Requests the adapter uses, with their params and results (bindings from the pinned Codex version). */
export interface CodexMethods {
  "thread/start": { params: v2.ThreadStartParams; result: v2.ThreadStartResponse };
  "thread/resume": { params: v2.ThreadResumeParams; result: v2.ThreadResumeResponse };
  "thread/fork": { params: v2.ThreadForkParams; result: v2.ThreadForkResponse };
  "thread/unsubscribe": { params: v2.ThreadUnsubscribeParams; result: v2.ThreadUnsubscribeResponse };
  "turn/start": { params: v2.TurnStartParams; result: v2.TurnStartResponse };
  "turn/steer": { params: v2.TurnSteerParams; result: v2.TurnSteerResponse };
  "turn/interrupt": { params: v2.TurnInterruptParams; result: v2.TurnInterruptResponse };
  "thread/goal/set": { params: v2.ThreadGoalSetParams; result: v2.ThreadGoalSetResponse };
  "thread/goal/get": { params: v2.ThreadGoalGetParams; result: v2.ThreadGoalGetResponse };
  "thread/goal/clear": { params: v2.ThreadGoalClearParams; result: v2.ThreadGoalClearResponse };
  "model/list": { params: v2.ModelListParams; result: v2.ModelListResponse };
  "thread/backgroundTerminals/list": { params: v2.ThreadBackgroundTerminalsListParams; result: v2.ThreadBackgroundTerminalsListResponse };
  "thread/backgroundTerminals/terminate": { params: v2.ThreadBackgroundTerminalsTerminateParams; result: v2.ThreadBackgroundTerminalsTerminateResponse };
}

/** Answers a server request (approval, user input, dynamic tool call). Throw RpcError to answer with an error. */
export type ServerRequestHandler = (request: Omit<ServerRequest, "id">) => Promise<unknown>;

export interface CodexAppServerOptions {
  readonly launch: CodexAppServerLaunch;
  readonly onServerRequest: ServerRequestHandler;
  readonly clientName?: string;
  readonly clientVersion: string;
}

export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    /** e.g. "open-agents-worker/0.164.0 (Linux ...)"; the Codex version is the first version in it. */
    readonly userAgent: string;
    request<M extends keyof CodexMethods>(method: M, params: CodexMethods[M]["params"]): Effect.Effect<CodexMethods[M]["result"], CodexAppServerError>;
    /** Every server notification, for all threads. Subscribe before triggering the work you want to observe. */
    readonly notifications: Stream.Stream<ServerNotification>;
    /** Last stderr lines of the process, for diagnostics. */
    stderrTail(): string;
  }
>()("open-agents/worker/CodexAppServer") {
  static readonly layer = (options: CodexAppServerOptions) =>
    Layer.effect(
      CodexAppServer,
      Effect.gen(function* () {
        const notifications = yield* PubSub.unbounded<ServerNotification>();
        const stderr: string[] = [];

        const proc = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([...options.launch.command], {
              env: options.launch.env,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
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
            onNotification: (method, params) =>
              Effect.runSync(PubSub.publish(notifications, { method, params } as ServerNotification)),
            onRequest: (method, params) => options.onServerRequest({ method, params } as Omit<ServerRequest, "id">),
          },
        );
        yield* Effect.forkScoped(Effect.promise(() => peer.run()));

        const call = (method: string, params: unknown) =>
          Effect.tryPromise({
            try: () => peer.request(method, params),
            catch: (error) =>
              new CodexAppServerError({
                method,
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof RpcError && { code: error.code }),
              }),
          });

        const initializeParams: InitializeParams = {
          clientInfo: { name: options.clientName ?? "open-agents-worker", title: null, version: options.clientVersion },
          // experimentalApi: dynamicTools (agent bus) and other experimental fields.
          capabilities: { experimentalApi: true, requestAttestation: false },
        };
        const initialized = (yield* call("initialize", initializeParams).pipe(Effect.timeout("30 seconds"))) as InitializeResponse;
        peer.notify("initialized");

        return CodexAppServer.of({
          userAgent: initialized.userAgent,
          request: (method, params) => call(method, params) as never,
          notifications: Stream.fromPubSub(notifications),
          stderrTail: () => stderr.slice(-50).join("\n"),
        });
      }),
    );
}

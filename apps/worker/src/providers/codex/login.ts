import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { CodexAppServer } from "./app-server.ts";
import type { CodexAppServerLaunch } from "./launch.ts";
import { withDeadline } from "../deadline.ts";

/**
 * Sign-in of a provider instance from the app (global provider instances, docs/worker-config.md, 9.5): Codex's own
 * login API (`account/login/start` with a ChatGPT device code). A short-lived `codex app-server` runs with the
 * instance's shadow home as CODEX_HOME, so Codex writes the login (auth.json) there and nowhere else. The user
 * confirms the code in any browser; the process waits for `account/login/completed` (at most `timeoutMs`) and ends.
 * The code and URL go to the UI; the tokens never leave Codex's home.
 */

export interface DeviceLogin {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly loginId: string;
  /** Settles when Codex reports the login finished (or failed, or timed out); the process is gone then. */
  readonly done: Promise<{ readonly success: boolean; readonly error?: string }>;
}

export async function startCodexDeviceLogin(options: {
  launch: CodexAppServerLaunch;
  clientVersion: string;
  timeoutMs?: number;
}): Promise<DeviceLogin> {
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));

  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        CodexAppServer.layer({
          launch: options.launch,
          clientVersion: options.clientVersion,
          // A login process runs no threads: nothing to approve.
          onServerRequest: () => Promise.reject(new Error("not supported during sign-in")),
        }),
        scope,
      ),
    );

    const server = Context.get(context, CodexAppServer);

    // Subscribed before the login starts, so a fast completion is not missed.
    const completed = await Effect.runPromise(
      Stream.runHead(server.notifications.pipe(Stream.filter((n) => n.method === "account/login/completed"))).pipe(
        Effect.forkIn(scope),
      ),
    );

    const started = await Effect.runPromise(server.request("account/login/start", { type: "chatgptDeviceCode" }));

    if (started.type !== "chatgptDeviceCode") throw new Error(`Codex answered a ${started.type} login`);
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;

    const done = (async () => {
      try {
        const outcome = await withDeadline(
          Effect.runPromise(Fiber.join(completed)),
          timeoutMs,
          () => "timeout" as const,
        );

        if (outcome === "timeout") return { success: false, error: "the sign-in code expired" };

        const params =
          outcome._tag === "Some" && outcome.value.method === "account/login/completed"
            ? outcome.value.params
            : undefined;

        if (!params) return { success: false, error: "Codex ended the sign-in without an answer" };

        return params.success ? { success: true } : { success: false, error: params.error ?? "the sign-in failed" };
      } finally {
        await close();
      }
    })();

    return { verificationUrl: started.verificationUrl, userCode: started.userCode, loginId: started.loginId, done };
  } catch (error) {
    await close();
    throw error;
  }
}

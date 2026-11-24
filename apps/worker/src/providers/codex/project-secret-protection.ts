import type { ThreadSpec } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import type { Journal } from "../../journal/index.ts";
import { projectSecretGuard } from "../../runtime/project-secret-guard.ts";
import { isString } from "../json.ts";
import { codexThreadProvider, type CodexAppServerLaunch } from "./launch.ts";
import {
  codexModelPath,
  codexResponsesHttpFallback,
  redactCodexJson,
  redactModelRequest,
} from "./project-secret-transport.ts";
import type { CodexThreadContext } from "./thread-types.ts";

const HookInput = Schema.Struct({
  hook_event_name: Schema.Literals(["SessionStart", "PostToolUse"]),
  session_id: Schema.String,
  tool_response: Schema.optionalKey(Schema.Json),
});

interface ProtectedThread {
  readonly path: string;
  readonly guard: ReturnType<typeof projectSecretGuard>;
  nativeId?: string;
  marked?: () => Promise<boolean>;
  hookSeen: boolean;
  retired: boolean;
}

async function respondToHook(request: Request, native: ReadonlyMap<string, ProtectedThread>) {
  try {
    const payload = Schema.decodeUnknownSync(HookInput)(await request.json());
    const thread = native.get(payload.session_id);

    if (!thread || thread.retired) return Response.json({});

    if (payload.hook_event_name === "SessionStart") {
      thread.hookSeen = true;

      return Response.json({});
    }

    if (payload.tool_response === undefined) return Response.json({});
    const original = JSON.stringify(payload.tool_response);
    const safe = redactCodexJson(payload.tool_response, thread.guard.redact);
    const encoded = JSON.stringify(safe);

    return Response.json(
      original === encoded
        ? {}
        : {
            decision: "block",
            reason: `A project secret was redacted from the tool result.\n${isString(safe) ? safe : encoded}`,
          },
    );
  } catch {
    return Response.json({ decision: "block", reason: "The tool result could not be checked for project secrets." });
  }
}

async function respondToInference(request: Request, baseUrl: URL, endpoint: string, thread: ProtectedThread) {
  return redactModelRequest(request, baseUrl, endpoint, thread.guard.redact, async () => {
    // Read the durable marker after receiving the whole request. The worker commits
    // it before putting a value on disk, so a request with missing patterns fails closed.
    const marked = await thread.marked?.();

    if (thread.retired || (marked && !thread.guard.hasValues())) return false;

    if (endpoint === "responses" && thread.hookSeen) thread.guard.ready();

    return true;
  });
}

// The hook runs before Codex accepts a completed tool result. The Responses
// relay protects the intermediate and error results which never reach it.
export function codexProjectSecretProtection(launch: CodexAppServerLaunch, userAgent: string) {
  const inference = launch.httpInference;
  const curl = process.platform === "win32" ? null : Bun.which("curl", { PATH: launch.env["PATH"] ?? "" });

  if (
    !inference ||
    !curl ||
    !verifiedVersion(userAgent) ||
    egressProxyConfigured(launch.env) ||
    egressProxyConfigured(process.env) ||
    launch.command.some((argument) => /^hooks[.=]/.test(argument))
  )
    return undefined;
  const { provider, baseUrl } = inference;
  const threads = new Map<string, ProtectedThread>();
  const paths = new Map<string, ProtectedThread>();
  const native = new Map<string, ProtectedThread>();
  const hookPath = `/${crypto.randomUUID()}/hook`;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      const url = new URL(request.url);

      if (url.pathname === hookPath && request.method === "POST") return respondToHook(request, native);

      const [, path, ...rest] = url.pathname.split("/");
      const thread = path ? paths.get(path) : undefined;
      const endpoint = rest.join("/");

      if (!thread?.nativeId || !codexModelPath(endpoint)) return new Response(null, { status: 404 });

      return codexResponsesHttpFallback(request, endpoint) ?? respondToInference(request, baseUrl, endpoint, thread);
    },
  });

  const hookCommand = `${shellQuote(curl)} -q --noproxy '*' --silent --fail --data-binary @- ${shellQuote(new URL(hookPath, server.url).href)}`;
  const hookConfig = threadHookConfig(hookCommand);
  let sawProjectSecret = false;
  let closed = false;

  const wantsProtection = (ctx: CodexThreadContext, spec: ThreadSpec) => {
    const profile = ctx.options.profile(spec.providerProfileId);

    return (
      !closed &&
      spec.projectSecretsConfigured &&
      spec.enableAgentBus &&
      !spec.sandboxProfile &&
      !spec.nativeSubagents &&
      profile?.kind === "cliproxyapi" &&
      codexThreadProvider(profile).modelProvider === provider
    );
  };

  const release = (threadId: string) => {
    const thread = threads.get(threadId);

    if (!thread) return;
    thread.guard.reset();
    threads.delete(threadId);
    paths.delete(thread.path);

    if (thread.nativeId) native.delete(thread.nativeId);
  };

  return {
    sawProjectSecret: () => sawProjectSecret,
    matches(ctx: CodexThreadContext, spec: ThreadSpec, nativeId: string) {
      return (threads.get(spec.threadId)?.nativeId === nativeId) === wantsProtection(ctx, spec);
    },
    bind(threadId: string, nativeId: string, journal: Journal["Service"]) {
      const thread = threads.get(threadId);

      if (!thread || thread.nativeId === nativeId) return;

      if (thread.nativeId) {
        native.delete(thread.nativeId);
        thread.guard.reset();
      }

      thread.hookSeen = false;
      thread.nativeId = nativeId;
      thread.marked = () => Effect.runPromise(journal.hasProjectSecretHistory(threadId, nativeId));
      native.set(nativeId, thread);
    },
    config(ctx: CodexThreadContext, spec: ThreadSpec) {
      if (!wantsProtection(ctx, spec)) return undefined;

      if (threads.get(spec.threadId)?.retired) release(spec.threadId);

      const thread = threads.get(spec.threadId) ?? {
        path: crypto.randomUUID(),
        guard: projectSecretGuard(spec.threadId),
        hookSeen: false,
        retired: false,
      };

      threads.set(spec.threadId, thread);
      paths.set(thread.path, thread);

      return {
        ...hookConfig,
        [`model_providers.${provider}.base_url`]: new URL(thread.path, server.url).href,
        [`model_providers.${provider}.model_catalog_url`]: new URL("models", baseUrl).href,
      };
    },
    reset(threadId: string) {
      const thread = threads.get(threadId);

      if (!thread) return;
      thread.guard.reset();
      thread.hookSeen = false;
    },
    retire(threadId: string, nativeId: string) {
      const thread = threads.get(threadId);

      if (thread?.nativeId === nativeId) {
        sawProjectSecret = true;
        thread.retired = true;
        thread.guard.reset();
      }
    },
    release,
    async close() {
      if (closed) return;
      closed = true;

      for (const thread of threads.values()) thread.guard.reset();
      threads.clear();
      paths.clear();
      native.clear();
      await server.stop(true);
    },
  };
}

// Both verified CLIs hash the normalized declaration as key-sorted JSON. Keep
// the declarations and trust in this thread's overrides, leaving other hooks alone.
function threadHookConfig(command: string) {
  const hook = { async: false, command, timeout: 5, type: "command" };
  const hooks = [{ hooks: [hook] }];

  const hash = (event: string) =>
    `sha256:${Bun.CryptoHasher.hash("sha256", JSON.stringify({ event_name: event, hooks: [hook] }), "hex")}`;

  return {
    "hooks.SessionStart": hooks,
    "hooks.PostToolUse": hooks,
    "hooks.state": {
      "/<session-flags>/config.toml:session_start:0:0": { enabled: true, trusted_hash: hash("session_start") },
      "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: true, trusted_hash: hash("post_tool_use") },
    },
  };
}

function egressProxyConfigured(env: CodexAppServerLaunch["env"]) {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some((name) => env[name] || env[name.toLowerCase()]);
}

function verifiedVersion(agent: string) {
  return /^\S+\/(?:0\.164\.0|0\.172\.0)(?:\s|$)/.test(agent);
}

function shellQuote(text: string) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

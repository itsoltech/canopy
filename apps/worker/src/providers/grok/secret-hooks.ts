import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InitializeResult } from "@canopy/grok-acp";
import { Option, Schema } from "effect";
import { projectSecretGuard } from "../../runtime/project-secret-guard.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import { redactToolOutput } from "../secret-tool-output.ts";

const Events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

const HookEvent = Schema.Struct({
  hook_event_name: Schema.Literals(Events),
  session_id: Schema.String,
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Json),
  toolResult: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});

const AgentVersion = Schema.Struct({
  _meta: Schema.Struct({ agentVersion: Schema.String }),
});

const decodeEvent = Schema.decodeUnknownOption(HookEvent);
const decodeVersion = Schema.decodeUnknownOption(AgentVersion);
const backgroundShell = Schema.is(Schema.Struct({ block_until_ms: Schema.Literal(0) }));

function supportsOutputReplacement(info: InitializeResult): boolean {
  const decoded = decodeVersion(info);

  if (Option.isNone(decoded)) return false;
  const match = /^1\.(\d+)\.(\d+)$/u.exec(decoded.value._meta.agentVersion);

  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 92);
}

function redactHookOutput(event: typeof HookEvent.Type, redact: (text: string) => string) {
  if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") return {};
  const output = event.hook_event_name === "PostToolUse" ? event.toolResult : event.error;

  if (output === undefined) return {};
  const redacted = redactToolOutput(output, redact);

  return redacted === output
    ? {}
    : { hookSpecificOutput: { hookEventName: event.hook_event_name, updatedToolOutput: redacted } };
}

function startsBackgroundCommand(event: typeof HookEvent.Type): boolean {
  return (
    event.hook_event_name === "PreToolUse" &&
    (event.tool_name === "monitor" || (event.tool_name === "run_terminal_command" && backgroundShell(event.tool_input)))
  );
}

/** Grok sends each synchronous callback to this process over a unique loopback URL. */
export function grokSecretHooks(threadId: string, home: string) {
  const guard = projectSecretGuard(threadId);
  const output = threadSecretOutputGuard(threadId);
  const path = `/${crypto.randomUUID()}`;
  let sessionId = "";
  let supported = false;
  let ready = false;
  let stopped: Promise<void> | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== path)
        return new Response(null, { status: 404 });

      try {
        const decoded = decodeEvent(await request.json());

        if (Option.isNone(decoded) || !sessionId) return new Response(null, { status: 400 });

        if (decoded.value.session_id !== sessionId) {
          if (ready) guard.reset();
          ready = false;

          return new Response(null, { status: 400 });
        }

        if (!ready && supported && decoded.value.hook_event_name === "UserPromptSubmit") {
          guard.ready();
          ready = true;
        }

        if (!output.hasValues()) return Response.json({});

        if (guard.hasValues() && startsBackgroundCommand(decoded.value))
          return Response.json({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Run the command in the foreground while a secret is accessible.",
            },
          });

        return Response.json(redactHookOutput(decoded.value, output.redact));
      } catch {
        return new Response(null, { status: 400 });
      }
    },
  });

  try {
    const hooks = Object.fromEntries(
      Events.map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${server.port}${path}`,
                timeout: 5,
                ...(event === "PreToolUse" && { failClosed: true }),
              },
            ],
          },
        ],
      ]),
    );

    const hooksDir = join(home, "hooks");
    mkdirSync(hooksDir, { mode: 0o700 });
    writeFileSync(join(hooksDir, "canopy-output-filter.json"), JSON.stringify({ hooks }), { mode: 0o600 });
  } catch (error) {
    void server.stop(true);
    throw error;
  }

  return {
    bind(id: string, info: InitializeResult) {
      sessionId = id;
      supported = supportsOutputReplacement(info);
    },
    close() {
      if (stopped) return stopped;
      sessionId = "";

      if (ready) guard.reset();

      stopped = server.stop(true);

      return stopped;
    },
  };
}

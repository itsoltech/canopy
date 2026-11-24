import type { CanUseTool, HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";
import { projectSecretGuard } from "../../runtime/project-secret-guard.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import { isString } from "../json.ts";
import { redactToolOutput } from "../secret-tool-output.ts";

const json = Schema.decodeUnknownOption(Schema.Json);
const backgroundShell = Schema.is(Schema.Struct({ run_in_background: Schema.Literal(true) }));

const supportedVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);

  return !!match && Number(match[1]) === 2 && Number(match[2]) === 1 && Number(match[3]) >= 316;
};

// A separate shell preserves the script's errexit behavior even when the CLI runs its
// outer command inside a conditional list. The outer shell reports explicit exits too.
const bashPrefix = `set +e
"\${BASH:-bash}" -c '`;

const bashSuffix = `'
__canopy_exit_status=$?
if [ "$__canopy_exit_status" -ne 0 ]; then
  printf '\\nCommand exited with status %s.\\n' "$__canopy_exit_status" >&2
fi`;

const bashEscapedQuote = "'\\''";

export function claudeSecretHooks(threadId: string, sessionId: string, readOnly: () => boolean) {
  const guard = projectSecretGuard(threadId);
  const output = threadSecretOutputGuard(threadId);
  let promptSeen = false;
  let supported = false;
  let closed = false;
  let ready = false;

  const confirm = () => {
    if (!closed && !ready && supported && promptSeen) {
      guard.ready();
      ready = true;
    }
  };

  const onPrompt: HookCallback = async (input) => {
    if (closed) return {};
    promptSeen = input.session_id === sessionId && input.permission_mode !== "bypassPermissions";

    if (!promptSeen && ready) {
      guard.reset();
      ready = false;
    }

    confirm();

    return {};
  };

  const beforeShell: HookCallback = async (input) => {
    if (closed || !supported || input.hook_event_name !== "PreToolUse" || !output.hasValues()) return {};

    if (guard.hasValues() && input.tool_name === "PowerShell")
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Use Bash or Read while a project secret is accessible. PowerShell error output cannot be masked.",
        },
      };

    if (guard.hasValues() && (input.tool_name === "Monitor" || backgroundShell(input.tool_input)))
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Run the command in the foreground while a secret is accessible.",
        },
      };

    if (input.tool_name !== "Bash" || (readOnly() && !guard.hasValues())) return {};

    return {
      // Let Claude apply its rules to the original input before Canopy can wrap an approved call.
      hookSpecificOutput: readOnly()
        ? {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Use a file read tool while a secret is accessible in read-only mode.",
          }
        : { hookEventName: "PreToolUse", permissionDecision: "ask" },
    };
  };

  const afterTool: HookCallback = async (input) => {
    if (closed || input.hook_event_name !== "PostToolUse" || !output.hasValues()) return {};
    const response = json(input.tool_response);

    if (Option.isNone(response)) return {};
    const original = response.value;
    const redacted = redactToolOutput(original, output.redact);

    if (redacted === original) return {};

    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted } };
  };

  const hooks = {
    UserPromptSubmit: [{ hooks: [onPrompt] }],
    PreToolUse: [{ matcher: "^(Bash|PowerShell|Monitor)$", hooks: [beforeShell] }],
    PostToolUse: [{ hooks: [afterTool] }],
  } satisfies NonNullable<Options["hooks"]>;

  return {
    hooks,
    protectBash(input: Parameters<CanUseTool>[1]) {
      const command = input["command"];

      if (closed || !supported || !output.hasValues() || !isString(command)) return input;

      return { ...input, command: bashPrefix + command.replaceAll("'", bashEscapedQuote) + bashSuffix };
    },
    version(version: string) {
      supported = supportedVersion(version);
      confirm();
    },
    close() {
      if (closed) return;
      closed = true;

      if (ready) guard.reset();
    },
  };
}

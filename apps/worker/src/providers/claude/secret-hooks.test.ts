import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Layer, ManagedRuntime } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "../../journal/index.ts";
import { projectSecretGuard, bindProjectSecretFilter } from "../../runtime/project-secret-guard.ts";
import { projectSecretModel } from "../fixtures/project-secret-model.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "../native-tools.ts";
import { redactToolOutput } from "../secret-tool-output.ts";
import { claudeSecretHooks } from "./secret-hooks.ts";
import { ClaudeThreads } from "./threads.ts";

const executable = Bun.which("claude");

test("Claude redacts nested tool output keys and keeps both values when redacted keys collide", async () => {
  const threadId = crypto.randomUUID();
  const value = `fixture-${crypto.randomUUID()}`;

  const unbind = bindProjectSecretFilter(threadId, {
    values: () => [value],
    retains: () => false,
    fence: () => {},
  });

  const session = claudeSecretHooks(threadId, threadId, () => false);

  try {
    const safe = { content: [{ metadata: { status: "ok" } }] };
    expect(redactToolOutput(safe, projectSecretGuard(threadId).redact)).toBe(safe);
    // An all-digit secret returned as a JSON number is masked too.
    const digits = (text: string) => text.replaceAll("482913", "[REDACTED]");
    expect(redactToolOutput({ result: 482913, other: 7 }, digits)).toEqual({ result: "[REDACTED]", other: 7 });
    const postToolUse = session.hooks.PostToolUse[0]!.hooks[0]!;

    const result = await postToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: threadId,
        transcript_path: "",
        cwd: "",
        tool_name: "mcp__fixture__nested",
        tool_use_id: "fixture-use",
        tool_input: {},
        tool_response: {
          content: [
            {
              metadata: {
                "key-[REDACTED]": { label: "existing" },
                [`key-${value}`]: { label: `value-${value}` },
                [`flag-${value}`]: true,
              },
            },
          ],
        },
      },
      "fixture-use",
      { signal: AbortSignal.timeout(1_000) },
    );

    expect(JSON.stringify(result).includes(value)).toBe(false);
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          content: [
            {
              metadata: {
                "key-[REDACTED]": [{ label: "existing" }, { label: "value-[REDACTED]" }],
                "flag-[REDACTED]": true,
              },
            },
          ],
        },
      },
    });
  } finally {
    session.close();
    unbind();
  }
});

test.skipIf(!executable || process.platform === "win32")(
  "Claude makes a project grant available to the first tool and redacts normal Bash output and errors through resume",
  async () => {
    const root = tempDir("canopy-claude-project-secret-");
    const home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Bash(cat denied-fixture.txt)"] } }),
    );
    writeFileSync(join(root, "denied-fixture.txt"), "denied fixture executed");
    const model = projectSecretModel();
    const threadId = crypto.randomUUID();
    const guard = projectSecretGuard(threadId);
    const values = new Set<string>();

    const unbind = bindProjectSecretFilter(threadId, {
      values: () => values,
      retains: () => false,
      fence: () => {},
    });

    const value = `fixture-${crypto.randomUUID()}`;
    let grantReady = false;
    const approvals: string[] = [];
    const finished = new Map<string, (event: ThreadEvent) => void>();

    const runtime = ManagedRuntime.make(
      ClaudeThreads.layer({
        executable: executable!,
        home,
        baseEnv: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
        profile: () => ({
          kind: "cliproxyapi",
          id: "fixture",
          providers: ["claude"],
          env: {},
          runtime: {},
          baseUrl: model.url,
          apiKey: "fixture-credential",
        }),
        publish(event) {
          if (event.body.case === "turnFinished") finished.get(event.turnId)?.(event);
        },
        interact: async (request) => {
          approvals.push(request.requestJson);

          return create(InteractionResponseSchema, { allow: true });
        },
        callTool: async (call) => {
          if (call.toolName === "get_thread")
            return create(AgentToolResultSchema, { content: `mcp failure: ${value}`, isError: true });

          grantReady = call.toolName === "request_secret" && guard.isReady();
          values.add(value);
          writeFileSync(join(root, "granted.txt"), value, { mode: 0o600 });
          writeFileSync(join(root, "read-fixture.txt"), `read result: ${value}`, { mode: 0o600 });

          return create(AgentToolResultSchema, { content: "Read fixture path granted.txt." });
        },
      }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
    );

    const spec = create(ThreadSpecSchema, {
      threadId,
      cwd: root,
      provider: Provider.CLAUDE,
      providerProfileId: "fixture",
      permissionMode: PermissionMode.ASK,
      enableAgentBus: true,
      model: "claude-haiku-4-5",
    });

    const turn = async (text: string) => {
      const id = crypto.randomUUID();
      const completion = Promise.withResolvers<ThreadEvent>();
      finished.set(id, completion.resolve);
      await runtime.runPromise(
        ClaudeThreads.use((threads) => threads.startTurn(spec, id, create(UserInputSchema, { text }))),
      );
      const { body } = await completion.promise;
      finished.delete(id);
      expect(body.case === "turnFinished" && body.value.outcome).toBe(TurnOutcome.COMPLETED);
    };

    try {
      await runtime.runPromise(ClaudeThreads.use((threads) => threads.create(spec)));
      model.steps.push(
        { name: "mcp__canopy__request_secret", args: { project_secret: "STAGING_TOKEN" } },
        { name: "mcp__canopy__get_thread", args: { thread_id: threadId } },
        { name: "Read", args: { file_path: join(root, "read-fixture.txt") } },
        { name: "Bash", args: { command: "cat denied-fixture.txt", description: "Read a forbidden file" } },
        {
          name: "Bash",
          args: {
            command: "printf 'background%s' '-executed'",
            description: "Background fixture",
            run_in_background: true,
          },
        },
        { name: "Bash", args: { command: "printf 'success: '; cat granted.txt", description: "Read a fixture" } },
        {
          name: "Bash",
          args: {
            command: "set -e; printf 'failure: ' >&2; cat granted.txt >&2; (exit 7); printf 'never%s' '-printed'",
            description: "Read a fixture and fail",
          },
        },
        undefined,
      );
      await turn("Use the first tool for a fixture grant.");
      expect(grantReady).toBe(true);
      expect(model.requests.some((body) => body.includes("mcp failure: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("read result: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("denied fixture executed"))).toBe(false);
      expect(approvals.some((request) => request.includes("cat denied-fixture.txt"))).toBe(false);
      expect(model.requests.some((body) => body.includes("Run the command in the foreground"))).toBe(true);
      expect(model.requests.some((body) => body.includes("background-executed"))).toBe(false);
      expect(model.requests.some((body) => body.includes("success: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("failure: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("Command exited with status 7."))).toBe(true);
      expect(model.requests.some((body) => body.includes("never-printed"))).toBe(false);
      expect(approvals.some((request) => request.includes("printf 'success: '; cat granted.txt"))).toBe(true);
      expect(approvals.some((request) => request.includes("__canopy_exit_status"))).toBe(false);
      expect(model.requests.some((body) => body.includes(value))).toBe(false);

      await runtime.runPromise(ClaudeThreads.use((threads) => threads.unload(threadId)));
      expect(guard.isReady()).toBe(false);
      const native = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: home }));
      const transcripts = await Promise.all(native.map((path) => Bun.file(join(home, path)).text()));
      expect(transcripts.some((transcript) => transcript.includes("[REDACTED]"))).toBe(true);
      expect(transcripts.some((transcript) => transcript.includes(value))).toBe(false);
      model.requests.length = 0;
      await turn("Resume the fixture grant thread.");
      expect(model.requests.some((body) => body.includes("[REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes(value))).toBe(false);
    } finally {
      await runtime.dispose();
      unbind();
      await model.close();
    }
  },
  20_000,
);

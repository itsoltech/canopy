import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadEventSchema,
  ThreadSecretDeliverySchema,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { projectSecretGuard, bindProjectSecretFilter } from "../../runtime/project-secret-guard.ts";
import { ThreadSecretFiles } from "../../runtime/thread-secrets.ts";
import { projectSecretModel } from "../fixtures/project-secret-model.ts";
import { GrokThreads } from "./threads.ts";

const executable = Bun.which("grok");

test.skipIf(!executable || process.platform === "win32")(
  "Grok ACP masks a private file in both shell outputs and leaves masked history after a process replacement",
  async () => {
    const root = tempDir("canopy-grok-project-secret-");
    const model = projectSecretModel();
    const threadId = crypto.randomUUID();
    const ready = () => projectSecretGuard(threadId).isReady();
    const value = `fixture-${crypto.randomUUID()}`;
    const manualValue = `manual-${crypto.randomUUID()}`;
    const unrelated = `fixture-${crypto.randomUUID()}`;
    const values = new Set<string>();

    const unbind = bindProjectSecretFilter(threadId, {
      values: () => values,
      retains: () => false,
      fence: () => {},
    });

    const unbindOther = bindProjectSecretFilter(crypto.randomUUID(), {
      values: () => [unrelated],
      retains: () => false,
      fence: () => {},
    });

    const outcomes: TurnOutcome[] = [];
    let readyAtFirstTool = false;
    const secrets = new ThreadSecretFiles(tempDir("canopy-grok-manual-secret-"));

    const threads = new GrokThreads({
      dataDir: root,
      executable: executable!,
      profile: () => ({
        kind: "cliproxyapi",
        id: "fixture",
        providers: ["grok"],
        env: { GROK_CLAUDE_HOOKS_ENABLED: "0", GROK_CURSOR_HOOKS_ENABLED: "0" },
        runtime: {},
        baseUrl: model.url,
        apiKey: "fixture-credential",
      }),
      linkDeviceLogin: false,
      record: async (_id, init) => {
        if (init.body?.case === "turnFinished") outcomes.push(init.body.value.outcome ?? TurnOutcome.UNSPECIFIED);

        return create(ThreadEventSchema);
      },
      interact: async () => create(InteractionResponseSchema, { allow: true }),
      callTool: async (call) => {
        if (call.toolName !== "request_secret") return create(AgentToolResultSchema, { isError: true });
        readyAtFirstTool = ready();
        values.add(value);
        writeFileSync(join(root, "granted.txt"), `${value}\n${unrelated}\n`, { mode: 0o600 });

        return create(AgentToolResultSchema, { content: "Read fixture path granted.txt." });
      },
    });

    const spec = create(ThreadSpecSchema, {
      threadId,
      cwd: root,
      provider: Provider.GROK,
      providerProfileId: "fixture",
      permissionMode: PermissionMode.FULL_ACCESS,
      model: "fixture-grok",
      enableAgentBus: true,
    });

    try {
      const manual = secrets.apply(
        create(ThreadSecretDeliverySchema, {
          threadId,
          requestId: crypto.randomUUID(),
          cwd: root,
          revision: 1,
          value: manualValue,
          expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
        }),
      );

      expect(ready()).toBe(false);
      expect(manual.applied).toBe(true);
      const manualPath = "'" + manual.file.replaceAll("'", "'\\''") + "'";

      const providerThreadId = await threads.create(spec);
      expect(ready()).toBe(false);
      model.steps.push(
        {
          name: "use_tool",
          args: { tool_name: "canopy__request_secret", tool_input: { project_secret: "STAGING_TOKEN" } },
        },
        {
          name: "run_terminal_command",
          args: { command: "printf 'background%s' '-executed'", description: "Background fixture", block_until_ms: 0 },
        },
        {
          name: "run_terminal_command",
          args: { command: "printf 'success: '; cat granted.txt", description: "Read a fixture" },
        },
        {
          name: "run_terminal_command",
          args: { command: `printf 'manual: '; cat ${manualPath}`, description: "Read the manual fixture" },
        },
        {
          name: "run_terminal_command",
          args: {
            command: "printf 'failure: ' >&2; cat granted.txt >&2; exit 7",
            description: "Read a fixture and fail",
          },
        },
        undefined,
      );
      const bound = create(ThreadSpecSchema, { ...spec, providerThreadId });
      await threads.startTurn(bound, crypto.randomUUID(), create(UserInputSchema, { text: "Read the fixture" }));
      expect(ready()).toBe(true);
      expect(readyAtFirstTool).toBe(true);
      expect(outcomes).toEqual([TurnOutcome.COMPLETED]);
      expect(model.requests.some((body) => body.includes("Run the command in the foreground"))).toBe(true);
      expect(model.requests.some((body) => body.includes("background-executed"))).toBe(false);
      expect(model.requests.some((body) => body.includes("success: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("manual: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("failure: [REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes("exit: 7"))).toBe(true);
      expect(model.requests.some((body) => body.includes(unrelated))).toBe(true);
      expect(model.requests.some((body) => body.includes(value))).toBe(false);
      expect(model.requests.some((body) => body.includes(manualValue))).toBe(false);

      await threads.unload(threadId);
      expect(ready()).toBe(false);
      values.clear();
      rmSync(join(root, "granted.txt"));
      model.requests.length = 0;
      await threads.startTurn(bound, crypto.randomUUID(), create(UserInputSchema, { text: "Resume the fixture" }));
      expect(ready()).toBe(true);
      expect(outcomes).toEqual([TurnOutcome.COMPLETED, TurnOutcome.COMPLETED]);
      expect(model.requests.some((body) => body.includes("[REDACTED]"))).toBe(true);
      expect(model.requests.some((body) => body.includes(value))).toBe(false);
      expect(model.requests.some((body) => body.includes(manualValue))).toBe(false);
    } finally {
      await threads.close();
      secrets.close();
      unbind();
      unbindOther();
      await model.close();
    }
  },
  20_000,
);

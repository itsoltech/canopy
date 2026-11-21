import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerNotification } from "@canopy/codex-protocol";
import { PermissionMode } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";
import { codexToolModel } from "../../bots/fixtures/codex-model.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { CodexAppServer } from "./app-server.ts";
import { codexAppServerLaunch, codexThreadLaunchArgs, codexThreadProvider } from "./launch.ts";
import { codexPermissions, codexTurnPermissions } from "./permissions.ts";
import { codexThreadCwd } from "./thread-params.ts";

const temp = tempDirs();
const codex = process.platform === "win32" ? Bun.which("codex.exe") : Bun.which("codex");

if (process.env["CANOPY_TEST_REQUIRE_CODEX"] === "1" && !codex) throw new Error("Codex CLI is required for this test.");

const ask = PermissionMode.ASK;
const fullAuto = PermissionMode.FULL_AUTO;
const status = { name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short --branch" }) };
const denied = { name: "exec_command", arguments: JSON.stringify({ cmd: "git --version" }) };
const restricted = { name: "exec_command", arguments: JSON.stringify({ cmd: "git branch --show-current" }) };

const InputItems = Schema.Array(
  Schema.Struct({ call_id: Schema.optionalKey(Schema.String), output: Schema.optionalKey(Schema.String) }),
);

function toolOutput(request: string, call: number) {
  return Schema.decodeUnknownSync(InputItems)(JSON.parse(request)).findLast((item) => item.call_id === `call-${call}`)
    ?.output;
}

function checkTurn(server: CodexAppServer["Service"], threadId: string, mode: PermissionMode) {
  return Effect.scoped(
    Effect.gen(function* () {
      const turnId = yield* Deferred.make<string>();

      const finished = yield* Effect.forkChild(
        server.notifications.pipe(
          Stream.filter(
            (event): event is Extract<ServerNotification, { method: "turn/completed" }> =>
              event.method === "turn/completed" && event.params.threadId === threadId,
          ),
          Stream.filterEffect((event) => Deferred.await(turnId).pipe(Effect.map((id) => event.params.turn.id === id))),
          Stream.runHead,
        ),
        { startImmediately: true },
      );

      const started = yield* server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Run the fixture command", text_elements: [] }],
        ...codexTurnPermissions(mode),
      });

      yield* Deferred.succeed(turnId, started.turn.id);
      const { turn } = Option.getOrThrow(yield* Fiber.join(finished)).params;
      expect({ status: turn.status, error: turn.error }).toEqual({ status: "completed", error: null });
    }),
  );
}

test.skipIf(!codex)(
  "sandboxed Codex commands follow mode changes, cold resume, and intentional command denials",
  async () => {
    const root = process.env["CANOPY_TEST_CODEX_ROOT"] || temp("canopy-codex-sandbox-");
    const cwd = join(root, "project");
    const home = join(root, "codex");
    mkdirSync(cwd);
    mkdirSync(join(home, "rules"), { recursive: true });
    writeFileSync(
      join(home, "rules", "default.rules"),
      [
        'prefix_rule(pattern=["git", "--version"], decision="forbidden", justification="fixture command denied")',
        'prefix_rule(pattern=["git", "branch", "--show-current"], decision="prompt")',
      ].join("\n"),
    );
    expect(Bun.spawnSync(["git", "init", "-qb", "canopy-fixture"], { cwd }).exitCode).toBe(0);

    // The last turn uses a new app-server process and the same rollout.
    const commands = [status, status, restricted, status, restricted, denied, status];
    const model = codexToolModel(commands.flatMap((call) => [call, null]));

    const profile: ResolvedProfile = {
      id: "fixture",
      kind: "cliproxyapi",
      baseUrl: new URL(model.url),
      apiKey: "fixture",
      providers: ["codex"],
      env: {},
      runtime: {},
    };

    const launch = codexAppServerLaunch(
      [profile],
      { ...process.env, HOME: root, OPENAI_BASE_URL: new URL("v1", model.url).href, OPENAI_API_KEY: "fixture" },
      codex!,
      undefined,
      home,
      {},
      codexThreadLaunchArgs([]),
    );

    const approvalRequests: string[] = [];

    const layer = CodexAppServer.layer({
      launch,
      clientVersion: "test",
      onServerRequest: async (request) => {
        approvalRequests.push(request.method);

        return { decision: "decline" };
      },
    });

    const params = {
      cwd: codexThreadCwd(cwd),
      model: "gpt-6.1-sol",
      ...codexThreadProvider(profile),
      config: { "features.code_mode": false },
    };

    try {
      const threadId = await Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const started = yield* server.request("thread/start", { ...params, ...codexPermissions(fullAuto) });
          expect(started.approvalPolicy).toBe("never");
          expect(started.sandbox.type).toBe("workspaceWrite");
          yield* checkTurn(server, started.thread.id, fullAuto);
          yield* checkTurn(server, started.thread.id, ask);
          yield* checkTurn(server, started.thread.id, ask);
          expect(approvalRequests).toEqual(["item/commandExecution/requestApproval"]);
          yield* checkTurn(server, started.thread.id, fullAuto);
          yield* checkTurn(server, started.thread.id, fullAuto);
          yield* checkTurn(server, started.thread.id, fullAuto);

          return started.thread.id;
        }).pipe(Effect.provide(layer), Effect.timeout("35 seconds")),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const resumed = yield* server.request("thread/resume", { threadId, ...params, ...codexPermissions(ask) });
          expect(resumed.thread.id).toBe(threadId);
          expect(resumed.approvalPolicy).toBe("on-request");
          expect(resumed.sandbox.type).toBe("readOnly");
          yield* checkTurn(server, threadId, fullAuto);
        }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
      );

      expect(model.requests).toHaveLength(14);

      for (const call of [1, 3, 7, 13])
        expect(toolOutput(model.requests[call]!, call), `Git status result for call ${call}`).toContain(
          "canopy-fixture",
        );
      expect(toolOutput(model.requests[9]!, 9)).toContain("approval required by policy");
      expect(toolOutput(model.requests[11]!, 11)).toContain("rejected: fixture command denied");
      expect(approvalRequests).toEqual(["item/commandExecution/requestApproval"]);
    } finally {
      await model.stop();
    }
  },
  60_000,
);

import { expect, test } from "bun:test";
import { PermissionMode } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Deferred, Effect, Stream } from "effect";
import { codexToolModel } from "../../bots/fixtures/codex-model.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexAppServer } from "./app-server.ts";
import { codexAgentBusTools } from "./dynamic-tools.ts";
import { codexAppServerLaunch, codexThreadProvider } from "./launch.ts";
import { codexPermissions, codexTurnPermissions } from "./permissions.ts";

const temp = tempDirs();

test.skipIf(!Bun.which("codex"))(
  "full-auto Codex threads dispatch Canopy dynamic tools without native approval",
  async () => {
    const dir = temp("canopy-codex-platform-tools-");
    const names = ["ask_user", "spawn_thread", "send_message"];
    const model = codexToolModel(names);
    const received: string[] = [];

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: model.url, apiKey: "fixture", providers: ["codex"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const launch = codexAppServerLaunch(
      [profile],
      { PATH: process.env["PATH"] ?? "", HOME: dir },
      "codex",
      undefined,
      dir,
    );

    const layer = CodexAppServer.layer({
      launch,
      clientVersion: "test",
      onServerRequest: async (request) => {
        if (request.method !== "item/tool/call") throw new Error(`Unexpected native approval: ${request.method}`);
        received.push(request.params.tool);

        return { contentItems: [{ type: "inputText", text: "GATEWAY_APPROVAL_RESULT" }], success: true };
      },
    });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const done = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            server.notifications.pipe(
              Stream.runForEach((event) =>
                event.method === "turn/completed" ? Deferred.succeed(done, undefined) : Effect.void,
              ),
            ),
          );

          const started = yield* server.request("thread/start", {
            model: "gpt-6.1-sol",
            ...codexThreadProvider(profile),
            cwd: dir,
            ...codexPermissions(PermissionMode.FULL_AUTO),
            dynamicTools: codexAgentBusTools(0),
            config: { project_doc_max_bytes: 0, "features.code_mode": false },
            ephemeral: true,
          });

          yield* server.request("turn/start", {
            threadId: started.thread.id,
            input: [{ type: "text", text: "Use the Canopy tools", text_elements: [] }],
            ...codexTurnPermissions(PermissionMode.FULL_AUTO),
          });
          yield* Deferred.await(done);
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("15 seconds")),
      );
      expect(received).toEqual(names);
      expect(model.requests.at(-1)).toContain("GATEWAY_APPROVAL_RESULT");
      expect(model.requests.join("\n")).not.toContain("approval policy is never");
    } finally {
      await model.stop();
    }
  },
  20_000,
);

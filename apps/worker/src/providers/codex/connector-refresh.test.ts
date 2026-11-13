import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ConnectorToolSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import { resolveProfiles } from "../profiles.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";
import { decodeJsonObject } from "../json.ts";

const temp = tempDirs();
const codex = Bun.which("codex");

/** The pinned app-server really refreshes its MCP inventory; no inference or device credentials. */
test.skipIf(!codex)(
  "Codex adds and removes connector tools between turns while retaining full history",
  async () => {
    const root = temp("canopy-codex-connectors-");
    const home = join(root, "codex");
    const cwd = join(root, "project");
    mkdirSync(home);
    mkdirSync(cwd);
    const model = startFakeModel();

    const profile = resolveProfiles([
      { id: "connector-test", kind: "cliproxyapi", baseUrl: model.url, apiKey: "fixture", providers: ["codex"] },
    ]).find((p) => p.config.id === "connector-test")!.resolved!;

    const events: ThreadEvent[] = [];

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.CODEX,
      cwd,
      model: "gpt-6.1-sol",
      permissionMode: PermissionMode.READ_ONLY,
    });

    const tool = create(ConnectorToolSchema, {
      accountId: crypto.randomUUID(),
      connectorType: "custom",
      accountName: "canopy",
      name: "fixture_connector_read",
      remoteName: "read",
      description: "Read a fixture marker",
      inputSchemaJson: '{"type":"object","properties":{}}',
      readOnly: true,
    });

    writeFileSync(join(home, "auth.json"), '{"OPENAI_API_KEY":"fixture"}');

    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch([profile], { PATH: process.env["PATH"] ?? "", HOME: root }, codex!, undefined, home),
      clientVersion: "test",
      profile: () => profile,
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema, { allow: false }),
      callTool: async () => create(AgentToolResultSchema, { content: "fixture result" }),
    }).pipe(Layer.provide(Journal.layer(join(root, "journal.db"))));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* CodexThreads;
          spec.providerThreadId = yield* threads.create(spec);

          for (const [index, tools] of [[tool], [], [tool], []].entries()) {
            spec.connectorTools = tools;
            const turnId = crypto.randomUUID();
            yield* threads.startTurn(
              spec,
              turnId,
              create(UserInputSchema, { text: `Remember FIXTURE_CONNECTOR_${index}` }),
              {
                model: "",
                effort: "",
                connectorNote: index === 0 ? "[canopy] Connector Custom MCP server · fixture is now available." : "",
              },
            );

            const done = yield* Effect.gen(function* () {
              for (;;) {
                const finished = events.find((e) => e.turnId === turnId && e.body.case === "turnFinished");

                if (finished) return finished;
                yield* Effect.sleep("20 millis");
              }
            }).pipe(Effect.timeout("20 seconds"));

            expect(
              done.body.case === "turnFinished" && { outcome: done.body.value.outcome, reason: done.body.value.reason },
            ).toEqual({ outcome: TurnOutcome.COMPLETED, reason: "" });

            const user = events.findLast(
              (e) =>
                e.turnId === turnId &&
                e.body.case === "itemCompleted" &&
                e.body.value.item?.content.case === "userMessage",
            );

            expect(
              user?.body.case === "itemCompleted" &&
                user.body.value.item?.content.case === "userMessage" &&
                user.body.value.item.content.value.text,
            ).toBe(`Remember FIXTURE_CONNECTOR_${index}`);
            const requests = model.requests.map((raw) => decodeJsonObject(JSON.parse(raw)));
            const request = requests.findLast((body) => Array.isArray(body["input"]))!;

            // The adapter checks the real per-thread MCP inventory before accepting every turn.
            if (index > 0) expect(JSON.stringify(request)).toContain("FIXTURE_CONNECTOR_0");
          }
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      await model.stop();
    }
  },
  90_000,
);

/** Opt-in inference regression: discover a connector added to an existing Codex session. */
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
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
import { resolveProfiles } from "../profiles.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const temp = tempDirs();
const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key || !Bun.which("codex"))(
  "Codex discovers an added connector, calls it, and remembers the preceding turn",
  async () => {
    const root = temp("canopy-codex-connectors-live-");
    const cwd = join(root, "project");
    mkdirSync(cwd);
    mkdirSync(join(root, "codex"));

    const profile = resolveProfiles([
      { id: "connector-live", kind: "cliproxyapi", baseUrl: url!, apiKey: key!, providers: ["codex"] },
    ]).find((p) => p.config.id === "connector-live")!.resolved!;

    const events: ThreadEvent[] = [];
    const remembered = `history-${crypto.randomUUID()}`;
    const result = `connector-${crypto.randomUUID()}`;
    let calls = 0;

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.CODEX,
      cwd,
      model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
      permissionMode: PermissionMode.READ_ONLY,
    });

    const tool = create(ConnectorToolSchema, {
      accountId: crypto.randomUUID(),
      accountName: "fixture",
      connectorType: "custom",
      name: "fixture_connector_read",
      remoteName: "read",
      description: "Read the connector's verification marker. No arguments.",
      inputSchemaJson: '{"type":"object","properties":{},"additionalProperties":false}',
      readOnly: true,
    });

    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(
        [profile],
        { PATH: process.env["PATH"] ?? "", HOME: root },
        "codex",
        undefined,
        join(root, "codex"),
      ),
      profile: () => profile,
      clientVersion: "test",
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema, { allow: false }),
      callTool: async (call) => {
        expect(call.connectorAccountId).toBe(tool.accountId);
        calls++;

        return create(AgentToolResultSchema, { content: result });
      },
    }).pipe(Layer.provide(Journal.layer(join(root, "journal.db"))));

    await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        spec.providerThreadId = yield* threads.create(spec);

        for (const [index, text] of [
          `Remember this exact marker for the next turn: ${remembered}. Reply only OK. Do not use tools.`,
          "[canopy] Connector Custom MCP server · fixture is now available.\nCall fixture_connector_read using your available MCP tools (discover it if necessary), then reply with its exact result and the marker I gave you in the preceding turn. Do not use shell, network or filesystem tools.",
          "[canopy] Connector Custom MCP server · fixture is no longer available.\nReply only OK. Do not use tools.",
        ].entries()) {
          spec.connectorTools = index === 1 ? [tool] : [];
          const id = crypto.randomUUID();
          yield* threads.startTurn(spec, id, create(UserInputSchema, { text }));

          const done = yield* Effect.gen(function* () {
            for (;;) {
              const event = events.find((e) => e.turnId === id && e.body.case === "turnFinished");

              if (event) return event;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(Effect.timeout("120 seconds"));

          expect(done.body.case === "turnFinished" && done.body.value.outcome).toBe(TurnOutcome.COMPLETED);

          if (index === 1) {
            const answers = events
              .flatMap((e) =>
                e.turnId === id && e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage"
                  ? e.body.value.item.content.value.text
                  : [],
              )
              .join("\n");

            expect(answers).toContain(result);
            expect(answers).toContain(remembered);
            expect(calls).toBe(1);
          }
        }
      }).pipe(Effect.provide(layer)),
    );
    expect(calls).toBe(1);
  },
  300_000,
);

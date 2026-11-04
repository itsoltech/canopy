/**
 * Live, below the gateway, for Codex and Claude through CLIProxyAPI: the catalog leaves out the proxy's models
 * that cannot run an agent turn (image, video, speech...), keeps its chat models without effort data, and reports
 * the device owner's configured default effort, which a turn without an effort of its own then runs with.
 * The device homes are fixtures (temp dirs), never the real ~/.codex or ~/.claude.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeviceLogin,
  PermissionMode,
  Provider,
  ProviderProfileKind,
  type ModelCatalog,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { journalHello } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const tempDir = tempDirs();

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

/** The configured default: a level both models offer that is not Codex's catalog default for them. */
const CONFIGURED = "medium";

const CASES = [
  {
    name: "Codex",
    provider: Provider.CODEX,
    model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
    permissionMode: PermissionMode.FULL_AUTO,
    config: { codex: { enabled: true, deviceLogin: DeviceLogin.NONE }, claude: { enabled: false } },
  },
  {
    name: "Claude",
    provider: Provider.CLAUDE,
    model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5",
    permissionMode: PermissionMode.ASK,
    config: { codex: { enabled: false }, claude: { enabled: true, deviceLogin: DeviceLogin.NONE } },
  },
] as const;

const NON_AGENT = /image|imagine|video|tts|voice|embedding|moderation|realtime|transcribe/i;

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("worker: model filter and configured default effort (live)", () => {
  for (const c of CASES) {
    test(`${c.name}: no non-agent models, the configured default effort in the catalog and in a turn`, async () => {
      const dir = tempDir(`canopy-live-effort-${c.name.toLowerCase()}-`);
      const repo = tempDir("canopy-live-effort-repo-");
      // Fixture device homes: a Codex profile with its own effort, a Claude per-model effort.
      const codexHome = join(dir, "device-codex");
      const claudeHome = join(dir, "device-claude");
      mkdirSync(codexHome);
      mkdirSync(claudeHome);
      writeFileSync(
        join(codexHome, "config.toml"),
        `model_reasoning_effort = "high"\nprofile = "work"\n\n[profiles.work]\nmodel_reasoning_effort = "${CONFIGURED}"\n`,
      );
      writeFileSync(
        join(claudeHome, "settings.json"),
        JSON.stringify({ effortLevel: "high", modelSettings: { [c.model]: { effortLevel: CONFIGURED } } }),
      );

      const gateway = await startGateway();
      const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));

      const host = new WorkerHost({
        runtime,
        dataDir: join(dir, "data"),
        clientVersion: "live",
        deviceHomes: { codex: codexHome, claude: claudeHome },
      });

      const link = await connectWorker(gateway.server.url, {
        hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) },
      });

      const serving = serveLink(link, host, runtime);
      const connection = await gateway.nextConnection();

      const events: ThreadEvent[] = [];
      let applied = false;
      let catalog: ModelCatalog | undefined;
      void (async () => {
        for await (const message of connection.messages) {
          const payload = message.payload;

          if (payload.case === "configApplied") applied = payload.value.applied;

          if (payload.case === "modelCatalog") catalog = payload.value;

          if (payload.case === "threadEvent") {
            events.push(payload.value);
            connection.send({
              case: "eventAck",
              value: { threadId: payload.value.threadId, ackSeq: payload.value.journalSeq },
            });
          }

          if (payload.case === "interactionRequest")
            connection.send({
              case: "interactionResponse",
              value: { requestId: payload.value.requestId, allow: true },
            });
        }
      })();

      connection.send({
        case: "config",
        value: {
          version: 1n,
          allowedRoots: [repo],
          ...c.config,
          profiles: [{ id: "live", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: proxyUrl!, apiKey: proxyKey! }],
        },
      });

      for (let i = 0; i < 600 && (!applied || !catalog); i++) await Bun.sleep(100);

      // 1. The catalog: no image/video/speech models, chat models of other vendors stay (with or without efforts).
      const live = catalog?.profiles.find((p) => p.provider === c.provider && p.profileId === "live");
      expect(live?.detail).toBe("");
      const models = live?.models ?? [];
      expect(models.filter((m) => NON_AGENT.test(`${m.id} ${m.displayName}`)).map((m) => m.id)).toEqual([]);
      expect(models.some((m) => /grok/i.test(`${m.id} ${m.displayName}`))).toBe(true);
      const chosen = models.find((m) => m.id === c.model || m.resolvedModel === c.model);
      expect(chosen?.efforts).toContain(CONFIGURED);
      expect(chosen?.defaultEffort).toBe(CONFIGURED);

      // A model without that level does not report it.
      for (const m of models) if (m.defaultEffort) expect(m.efforts).toContain(m.defaultEffort);
      console.info(
        `${c.name}: ${models.length} agent models; ${chosen?.id} default effort ${chosen?.defaultEffort}; without efforts: ${models.filter((m) => m.efforts.length === 0).length}`,
      );

      // 2. A turn without an effort runs with the configured default.
      const threadId = Bun.randomUUIDv7();

      const spec = {
        threadId,
        provider: c.provider,
        providerProfileId: "live",
        cwd: repo,
        permissionMode: c.permissionMode,
      };

      expect(await connection.sendCommand({ case: "createThread", value: { thread: spec } }, 60_000)).toMatchObject({
        ok: true,
      });
      const ready = events.find((e) => e.threadId === threadId && e.body.case === "threadReady");

      const withThread = {
        ...spec,
        providerThreadId: ready?.body.case === "threadReady" ? ready.body.value.providerThreadId : "",
      };

      const turnId = Bun.randomUUIDv7();

      const prompt =
        c.provider === Provider.CLAUDE
          ? "Run `echo effort=$CLAUDE_EFFORT` with the Bash tool and reply with its output only."
          : "Reply with the single word OK.";

      expect(
        await connection.sendCommand(
          { case: "startTurn", value: { thread: withThread, turnId, input: { text: prompt }, model: c.model } },
          60_000,
        ),
      ).toMatchObject({ ok: true });
      const deadline = Date.now() + 240_000;

      while (!events.some((e) => e.turnId === turnId && e.body.case === "turnFinished") && Date.now() < deadline)
        await Bun.sleep(100);
      const finished = events.find((e) => e.turnId === turnId && e.body.case === "turnFinished");
      expect(finished?.body.case === "turnFinished" ? finished.body.value.outcome : undefined).toBe(1);

      if (c.provider === Provider.CODEX) {
        const settings = events
          .filter((e) => e.threadId === threadId)
          .map(
            (e) =>
              JSON.parse(e.rawJson || "{}") as {
                method?: string;
                params?: { threadSettings?: { model?: string; effort?: string } };
              },
          )
          .filter((n) => n.method === "thread/settings/updated")
          .at(-1)?.params?.threadSettings;

        expect([settings?.model, settings?.effort]).toEqual([c.model, CONFIGURED]);
      } else {
        const text = events
          .flatMap((e) =>
            e.turnId === turnId && e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage"
              ? [e.body.value.item.content.value.text]
              : [],
          )
          .join("\n");

        expect(text).toContain(`effort=${CONFIGURED}`);
      }

      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
      await gateway.link.shutdown();
      await gateway.server.close();
    }, 600_000);
  }
});

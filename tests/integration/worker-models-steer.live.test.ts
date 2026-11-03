/**
 * Live, below the gateway, for Codex and Claude through CLIProxyAPI: the worker host lists the models of the
 * profile after its config (no model turn), runs a turn with a chosen model and reasoning effort, and takes a
 * steered message into a running turn (Codex turn/steer, Claude streaming input).
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DeviceLogin, PermissionMode, Provider, ProviderProfileKind, type ModelCatalog, type ThreadEvent } from "@canopy/contracts";
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

const CASES = [
  {
    name: "Codex",
    provider: Provider.CODEX,
    model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
    // Codex runs the command without asking (workspace-write); Claude asks and the test allows it.
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

const agentText = (events: ThreadEvent[], turnId: string) =>
  events
    .flatMap((e) => (e.turnId === turnId && e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage" ? [e.body.value.item.content.value.text] : []))
    .join("\n");

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("worker: models, effort and steer (live)", () => {
  for (const c of CASES) {
    test(`${c.name}: model list, a turn with a chosen effort, a steer into a running turn`, async () => {
      const dir = tempDir(`oa-live-models-${c.name.toLowerCase()}-`);
      const repo = tempDir(`oa-live-models-repo-`);
      const gateway = await startGateway();
      const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
      const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) } });
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
            connection.send({ case: "eventAck", value: { threadId: payload.value.threadId, ackSeq: payload.value.journalSeq } });
          }
          if (payload.case === "interactionRequest") connection.send({ case: "interactionResponse", value: { requestId: payload.value.requestId, allow: true } });
        }
      })();

      connection.send({
        case: "config",
        value: { version: 1n, allowedRoots: [repo], ...c.config, profiles: [{ id: "live", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: proxyUrl!, apiKey: proxyKey! }] },
      });
      for (let i = 0; i < 600 && (!applied || !catalog); i++) await Bun.sleep(100);

      // 1. The catalog after the config: the live profile's models with their efforts (and the native profile's).
      const live = catalog?.profiles.find((p) => p.provider === c.provider && p.profileId === "live");
      expect(live?.detail).toBe("");
      const chosen = live?.models.find((m) => m.id === c.model || m.resolvedModel === c.model);
      expect(chosen?.efforts).toContain("low");
      const listed = await connection.sendCommand({ case: "listModels", value: { provider: c.provider, profileId: "live" } }, 90_000);
      expect(listed.ok).toBe(true);
      expect(listed.models.map((p) => [p.provider, p.profileId])).toEqual([[c.provider, "live"]]);
      expect(listed.models[0]?.models.some((m) => m.id === chosen?.id)).toBe(true);
      console.info(`${c.name} live profile: ${live?.models.length} models; ${c.model} efforts ${chosen?.efforts.join(", ")}`);

      const threadId = Bun.randomUUIDv7();
      const spec = { threadId, provider: c.provider, providerProfileId: "live", cwd: repo, permissionMode: c.permissionMode };
      expect(await connection.sendCommand({ case: "createThread", value: { thread: spec } }, 60_000)).toMatchObject({ ok: true });
      const ready = events.find((e) => e.threadId === threadId && e.body.case === "threadReady");
      const withThread = { ...spec, providerThreadId: ready?.body.case === "threadReady" ? ready.body.value.providerThreadId : "" };

      const finished = async (turnId: string, timeoutMs = 240_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!events.some((e) => e.turnId === turnId && e.body.case === "turnFinished") && Date.now() < deadline) await Bun.sleep(100);
        const event = events.find((e) => e.turnId === turnId && e.body.case === "turnFinished");
        return event?.body.case === "turnFinished" ? event.body.value : undefined;
      };

      // 2. A turn with the chosen model and effort "low": Codex reports its settings, Claude Code exposes the
      //    effort to Bash (CLAUDE_EFFORT).
      const effortTurn = Bun.randomUUIDv7();
      const prompt =
        c.provider === Provider.CLAUDE
          ? "Run `echo effort=$CLAUDE_EFFORT` with the Bash tool and reply with its output only."
          : "Reply with the single word OK.";
      expect(
        await connection.sendCommand({ case: "startTurn", value: { thread: withThread, turnId: effortTurn, input: { text: prompt }, model: c.model, effort: "low" } }, 60_000),
      ).toMatchObject({ ok: true });
      expect((await finished(effortTurn))?.outcome).toBe(1);
      if (c.provider === Provider.CODEX) {
        const settings = events
          .filter((e) => e.threadId === threadId)
          .map((e) => JSON.parse(e.rawJson || "{}") as { method?: string; params?: { threadSettings?: { model?: string; effort?: string } } })
          .filter((n) => n.method === "thread/settings/updated")
          .at(-1)?.params?.threadSettings;
        expect([settings?.model, settings?.effort]).toEqual([c.model, "low"]);
      } else {
        expect(agentText(events, effortTurn)).toContain("effort=low");
      }

      // 3. Steer: while the command runs, a message joins the turn; the answer follows it.
      const steerTurn = Bun.randomUUIDv7();
      expect(
        await connection.sendCommand(
          {
            case: "startTurn",
            value: {
              thread: withThread,
              turnId: steerTurn,
              input: { text: "Run the shell command `sleep 8; echo first` (one command, wait for it). Then reply with its output, one line." },
              model: c.model,
              effort: "low",
            },
          },
          60_000,
        ),
      ).toMatchObject({ ok: true });
      const commandStarted = () =>
        events.some((e) => e.turnId === steerTurn && e.body.case === "itemStarted" && e.body.value.item?.content.case === "commandExecution");
      for (let i = 0; i < 1200 && !commandStarted(); i++) await Bun.sleep(100);
      expect(commandStarted()).toBe(true);
      const inputId = Bun.randomUUIDv7();
      const steered = await connection.sendCommand(
        { case: "steerTurn", value: { threadId, turnId: steerTurn, inputId, input: { text: "Change of plan from the user: your final answer must end with the word BANANA." } } },
        60_000,
      );
      expect(steered).toMatchObject({ ok: true });
      // A redelivered steer is not sent twice.
      expect(await connection.sendCommand({ case: "steerTurn", value: { threadId, turnId: steerTurn, inputId, input: { text: "Change of plan from the user: your final answer must end with the word BANANA." } } }, 60_000)).toMatchObject({ ok: true });
      const outcome = await finished(steerTurn);
      expect(outcome?.outcome).toBe(1);
      const entered = events.filter(
        (e) => e.body.case === "itemCompleted" && e.body.value.item?.content.case === "userMessage" && e.body.value.item.content.value.clientId === inputId,
      );
      expect(entered.map((e) => e.turnId)).toEqual([steerTurn]);
      expect(agentText(events, steerTurn)).toContain("BANANA");
      // The steered message entered after the command started (where it joined the turn).
      const commandAt = events.findIndex((e) => e.turnId === steerTurn && e.body.case === "itemStarted" && e.body.value.item?.content.case === "commandExecution");
      expect(events.indexOf(entered[0]!)).toBeGreaterThan(commandAt);

      // 4. Steer while the model answers without tools: Claude Code takes the message only after the result,
      //    so the turn goes on past that result (one turn_finished); Codex continues the turn with it.
      const replyTurn = Bun.randomUUIDv7();
      expect(
        await connection.sendCommand(
          { case: "startTurn", value: { thread: withThread, turnId: replyTurn, input: { text: "Write four short lines about the sea. No tools." }, model: c.model, effort: "low" } },
          60_000,
        ),
      ).toMatchObject({ ok: true });
      const replying = () => events.some((e) => e.turnId === replyTurn && e.body.case === "itemDelta");
      for (let i = 0; i < 1200 && !replying(); i++) await Bun.sleep(50);
      const afterReply = Bun.randomUUIDv7();
      const steeredLate = await connection.sendCommand(
        { case: "steerTurn", value: { threadId, turnId: replyTurn, inputId: afterReply, input: { text: "Then add one line about mountains that ends with the word BANANA." } } },
        60_000,
      );
      if (steeredLate.ok) {
        expect((await finished(replyTurn))?.outcome).toBe(1);
        expect(events.filter((e) => e.turnId === replyTurn && e.body.case === "turnFinished")).toHaveLength(1);
        const joined = events.find((e) => e.body.case === "itemCompleted" && e.body.value.item?.content.case === "userMessage" && e.body.value.item.content.value.clientId === afterReply);
        const dropped = events.find((e) => e.body.case === "notice" && e.body.value.code === "steer_dropped" && e.body.value.dataJson.includes(afterReply));
        // Either it joined (and was answered) or it is reported as dropped, never lost.
        expect(Boolean(joined) !== Boolean(dropped)).toBe(true);
        if (joined) expect(agentText(events, replyTurn)).toContain("BANANA");
        // Claude: a result before the steered message started is kept without a body (the turn went on).
        const results = events.filter((e) => e.turnId === replyTurn && (JSON.parse(e.rawJson || "{}") as { type?: string }).type === "result").length;
        console.info(`${c.name} steer during a reply: ${joined ? "joined the turn" : "dropped (queued by the gateway)"}${c.provider === Provider.CLAUDE ? `, ${results} result(s)` : ""}`);
      } else {
        // The reply was already over: refused, the gateway queues it.
        expect(steeredLate.errorCode).toBe("STEER_NOT_RUNNING");
        console.info(`${c.name} steer during a reply: the turn had ended`);
        await finished(replyTurn);
      }

      // 5. The turn is over: a late steer is refused, so the gateway can queue it.
      const late = await connection.sendCommand({ case: "steerTurn", value: { threadId, turnId: steerTurn, inputId: Bun.randomUUIDv7(), input: { text: "late" } } }, 60_000);
      expect([late.ok, late.errorCode]).toEqual([false, "STEER_NOT_RUNNING"]);

      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
      await gateway.link.shutdown();
      await gateway.server.close();
    }, 600_000);
  }
});

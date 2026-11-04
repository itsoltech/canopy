import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { CommandSchema, MentionKind, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";
import { fakeConnector } from "./support/connector.ts";

describe.skipIf(!dockerAvailable)("bot capabilities on the harness runtime", () => {
  let f: HarnessBots;
  const connector = fakeConnector({ call: (_name, args) => ({ received: args }) });
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await connector.close();
    await f?.close();
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} routine and wakeup use the harness and preserve visibility`, async () => {
      const bot = await f.add(provider);
      await f.tool(bot.id, "create_routine", {
        title: "Background check",
        instructions: "Check silently",
        cron: "*/15 * * * *",
        timezone: "UTC",
      });
      const baseline = await f.settled(bot.id);
      expect(baseline.routines).toHaveLength(1);
      const routine = baseline.routines[0]!;
      await f.query("UPDATE bot_routines SET next_run_at = now() - interval '1 minute' WHERE id=$1", [routine.id]);
      await f.gw.core.bots.tick();

      const hidden = await eventually(
        () => f.read(bot.id),
        (r) => r.routines[0]?.runCount === 1 && r.routines[0]?.lastOutcome === "Nothing to report",
      );

      expect(hidden.messages).toEqual(baseline.messages);
      expect(hidden.routines[0]?.lastOutcome).toBe("Nothing to report");
      await f.tool(bot.id, "schedule_wakeup", {
        prompt: "Wakeup marker",
        run_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const scheduled = await f.settled(bot.id);
      expect(scheduled.reminders).toHaveLength(1);
      await f.query("UPDATE bot_wakeups SET run_at = now() - interval '1 minute' WHERE bot_id=$1", [bot.id]);
      await f.gw.core.bots.tick();

      const awake = await eventually(
        () => f.read(bot.id),
        (r) => !r.working && r.messages.some((m) => m.text.includes("Wakeup marker") && m.kind === "event"),
      );

      expect(awake.messages.at(-1)?.text).toBe("FIXTURE_OK");

      const turns = await f.query<{ total: number }>(
        "SELECT count(*)::int total FROM bot_harness_turns WHERE bot_id=$1",
        [bot.id],
      );

      expect(turns[0]?.total).toBe(4);
      await f.gw.api.deleteBotRoutine({ botId: bot.id, routineId: routine.id });
    });

    test(`${Provider[provider]} handoff is hidden and uses the old harness with no tools`, async () => {
      const bot = await f.add(provider);
      await f.send(bot.id, "Remember Fern");
      const before = await f.settled(bot.id);
      await f.gw.api.updateBot({
        botId: bot.id,
        configuration: { ...bot.configuration!, provider: provider === Provider.GROK ? Provider.CODEX : Provider.GROK },
      });
      await eventually(
        () =>
          f.query<{ note: string; fallback_reason: string }>(
            "SELECT note, fallback_reason FROM bot_handoff_notes WHERE bot_id=$1",
            [bot.id],
          ),
        (r) => r.length === 1,
      );
      const after = await f.settled(bot.id);
      expect(after.messages).toEqual(before.messages);

      const notes = await f.query<{ note: string; fallback_reason: string }>(
        "SELECT note, fallback_reason FROM bot_handoff_notes WHERE bot_id=$1",
        [bot.id],
      );

      expect(notes[0]).toMatchObject({ note: "FIXTURE_OK", fallback_reason: "" });

      const jobs = await f.query<{ payload: Uint8Array }>(
        "SELECT c.payload FROM bot_harness_turns h JOIN worker_commands c ON c.id=h.command_id JOIN bot_turns t ON t.id=h.turn_id WHERE h.bot_id=$1 AND t.handoff_configuration IS NOT NULL",
        [bot.id],
      );

      const command = fromBinary(CommandSchema, jobs[0]!.payload);
      expect(command.kind.case).toBe("runBotTurn");

      if (command.kind.case === "runBotTurn") {
        expect(command.kind.value.provider).toBe(provider);
        expect(command.kind.value.tools).toHaveLength(0);
      }

      await f.send(bot.id, "Continue after the switch");
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    });

    test(`${Provider[provider]} connector MCP uses the gateway bus, grants and approvals`, async () => {
      const bot = await f.add(provider, f.workerId, "always");

      const account = (
        await f.gw.api.saveConnectorAccount({
          connectorType: "custom",
          name: `Harness ${Provider[provider]}`,
          url: connector.url,
          authKind: "headers",
          token: connector.secret,
        })
      ).account!;

      await f.gw.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        botIds: [bot.id],
      });
      const tool = (await f.gw.api.testConnector({ accountId: account.id })).tools[0]!;
      const calls = connector.calls.length;
      await f.tool(bot.id, tool.name, { marker: "through-harness" });

      const pending = await eventually(
        () => f.read(bot.id),
        (r) => r.approvals.some((a) => a.status === "pending"),
      );

      expect(connector.calls).toHaveLength(calls);
      await f.gw.api.answerBotApproval({ approvalId: pending.approvals[0]!.id, approve: true });
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("through-harness");
      expect(connector.calls).toHaveLength(calls + 1);
      expect(JSON.stringify(f.records())).not.toContain(connector.secret);
      await f.gw.api.disconnectConnector({ accountId: account.id });
    });
  }

  test("create-bot accepts explicit Grok, keeps approval and the child runs through ACP", async () => {
    const parent = await f.add(Provider.CODEX, f.workerId, "always");
    const name = `Child ${crypto.randomUUID().slice(0, 8)}`;
    await f.tool(parent.id, "create_bot", {
      name,
      provider: "grok",
      model: "fixture-model",
      provider_instance: "native",
    });

    const pending = await eventually(
      () => f.read(parent.id),
      (r) => r.approvals.some((a) => a.status === "pending"),
    );

    expect((await f.gw.api.listBots({})).bots.some((b) => b.configuration?.name === name)).toBe(false);
    await f.gw.api.answerBotApproval({ approvalId: pending.approvals[0]!.id, approve: true });
    await f.settled(parent.id);
    const child = (await f.gw.api.listBots({})).bots.find((b) => b.configuration?.name === name)!;
    expect(child.configuration?.provider).toBe(Provider.GROK);
    await f.send(child.id, "Hello child");
    expect((await f.settled(child.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
  });

  test("multiple mentions retain exact bot ids and bot-to-bot replies use the target harness", async () => {
    const source = await f.add(Provider.CLAUDE);
    const targets = [await f.add(Provider.CODEX), await f.add(Provider.GROK)];
    const labels = targets.map((b) => `@${b.configuration!.name}`);
    const text = labels.join(" ");
    await f.gw.api.sendBotMessage({
      botId: source.id,
      text,
      clientRequestId: crypto.randomUUID(),
      mentions: targets.map((b, i) => ({
        kind: MentionKind.BOT,
        name: b.id,
        label: b.configuration!.name,
        start: i === 0 ? 0 : labels[0]!.length + 1,
        end: i === 0 ? labels[0]!.length : text.length,
      })),
    });
    const snapshot = await f.settled(source.id);
    expect(snapshot.messages[0]?.mentions.map((m) => m.name)).toEqual(targets.map((b) => b.id));

    for (const target of targets) {
      await f.tool(source.id, "send_bot_message", { bot_id: target.id, text: "Hello through the bus" });
      await eventually(
        () => f.read(target.id),
        (r) => !r.working && r.messages.at(-1)?.text === "FIXTURE_OK",
      );
      await f.settled(source.id);
    }
  });
});

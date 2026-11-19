import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { oauthRedirectUrl } from "../../apps/gateway/src/connectors/catalog.ts";
import { eventually } from "./support/gateway.ts";
import { fakeConnector } from "./support/connector.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { slackOAuthFixture } from "./support/slack-oauth.ts";

describe.skipIf(!dockerAvailable)("direct Slack posts through gateway and worker", () => {
  const mcp = fakeConnector({ userToken: true });
  const slack = slackOAuthFixture();
  const posts: { fields: URLSearchParams; usedBotToken: boolean }[] = [];
  let f: HarnessBots;

  beforeAll(async () => {
    f = await harnessBots({
      messengerTransport: {
        ...slack.transport,
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (!new URL(request.url).pathname.endsWith("/chat.postMessage")) return fetch(request);
          const fields = new URLSearchParams(await request.text());
          const usedBotToken = request.headers.get("authorization")?.startsWith("Bearer xoxe.xoxb-") === true;
          posts.push({ fields, usedBotToken });

          return Response.json({ ok: true, channel: fields.get("channel"), ts: `1234.00000${posts.length}` });
        },
      },
    });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
    slack.close();
    mcp.close();
  });

  test("a standing rule is explicit, scoped to a destination, and revocable", async () => {
    const { api, core, userId } = f.gw;
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await api.saveConnectorOAuthApp({
      connectorType: "slack",
      ...mcp.registeredApp(oauthRedirectUrl()),
      issuer: mcp.issuer,
    });

    const account = (
      await api.saveConnectorAccount({ connectorType: "slack", name: "Work Slack", url: mcp.url, authKind: "oauth" })
    ).account!;

    const request = {
      accountId: account.id,
      browserBinding: "b".repeat(43),
      redirectUri: "http://127.0.0.1:19129/api/connectors/oauth/callback",
    };

    const start = await api.beginConnectorOAuth(request);
    const back = new URL((await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location")!);

    const connected = await api.completeConnectorOAuth({
      state: back.searchParams.get("state")!,
      code: back.searchParams.get("code")!,
      browserBinding: request.browserBinding,
      issuer: mcp.issuer,
    });

    expect(connected.error).toBe("");
    await api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: connected.account!.revision,
      botIds: [bot.id],
    });
    const catalog = () => core.connectors.tools(userId, { botId: bot.id });
    expect((await catalog()).some((tool) => tool.name.endsWith("__canopy_post_slack"))).toBe(false);

    await api.saveMessengerAccount({ name: "Work Slack", connectorAccountId: account.id, appToken: "xapp-fixture" });
    const messaging = await api.beginConnectorOAuth({ ...request, slackMessaging: true });
    expect(
      (
        await api.completeConnectorOAuth({
          ...slack.consent(messaging.authorizationUrl),
          browserBinding: request.browserBinding,
        })
      ).error,
    ).toBe("");
    const post = (await catalog()).find((tool) => tool.name.endsWith("__canopy_post_slack"))!;
    expect(post.readOnly).toBe(false);
    expect(
      (await core.connectors.tools(userId, { workerId: f.workerId })).some((tool) => tool.name === post.name),
    ).toBe(false);

    const replyIn = (channel: string, parent: string) =>
      f.tool(bot.id, post.name, { channel, reply_to: parent, message: "**Follow-up** <done>" });

    const pending = async () =>
      (
        await eventually(
          () => f.read(bot.id),
          (view) => view.approvals.some((card) => card.status === "pending"),
          10_000,
        )
      ).approvals.find((card) => card.status === "pending")!;

    await replyIn("C123", "1234.123456");
    const first = await pending();
    expect(posts).toHaveLength(0);
    expect(first.ruleOptions).toHaveLength(1);
    expect(first.fields.map((field) => field.label).sort()).toEqual(["Channel", "Message", "Reply to"]);
    const rule = first.ruleOptions[0]!;
    expect(rule).toMatchObject({ targetId: account.id, toolName: "C123" });
    await api.answerBotApproval({ approvalId: first.id, approve: true, ruleOptionId: rule.id });
    await f.settled(bot.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.usedBotToken).toBe(true);
    expect(Object.fromEntries(posts[0]!.fields)).toMatchObject({
      channel: "C123",
      text: "Follow-up &lt;done&gt;",
      thread_ts: "1234.123456",
    });
    expect(JSON.parse(posts[0]!.fields.get("blocks") ?? "null")).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Follow-up", style: { bold: true } },
              { type: "text", text: " " },
              { type: "text", text: "<done>" },
            ],
          },
        ],
      },
    ]);

    await f.tool(bot.id, "create_routine", {
      title: "Post a release update",
      instructions: `TOOL:${post.name}\nARGS:{"channel":"C123","reply_to":"1234.234567","message":"Release update"}`,
      cron: "0 0 * * *",
      timezone: "UTC",
    });
    const routine = (await f.settled(bot.id)).routines[0]!;

    const runRoutine = async () => {
      await f.query("UPDATE bot_routines SET next_run_at=now() WHERE id=$1", [routine.id]);
      await core.bots.tick();
    };

    await runRoutine();

    const second = await eventually(
      () => f.read(bot.id),
      (view) => view.routines[0]?.lastOutcome === "Completed background actions",
    );

    expect(second.approvals.at(-1)).toMatchObject({ routineTitle: routine.title, allowedByRule: { id: rule.id } });
    expect(posts).toHaveLength(2);
    expect(posts[1]?.fields.get("thread_ts")).toBe("1234.234567");
    expect(mcp.calls).toEqual([]);

    await replyIn("C456", "1234.345678");
    const other = await pending();
    expect(other.allowedByRule).toBeUndefined();
    await api.answerBotApproval({ approvalId: other.id, approve: false });
    await f.settled(bot.id);
    await api.deleteBotApprovalRule({ botId: bot.id, ruleId: rule.id });
    await runRoutine();
    const revoked = await pending();
    expect(revoked.routineTitle).toBe(routine.title);
    expect(revoked.allowedByRule).toBeUndefined();
    expect(posts).toHaveLength(2);
    await api.answerBotApproval({ approvalId: revoked.id, approve: false });
    await f.settled(bot.id);

    const current = (await api.listConnectors({})).accounts.find((item) => item.id === account.id)!;
    await api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: current.revision,
      botIds: [bot.id],
      workerIds: [f.workerId],
    });
    const thread = await f.thread(Provider.CODEX);

    const turn = await api.sendMessage({
      threadId: thread.id,
      text: "HOLD:slack-post",
      clientRequestId: crypto.randomUUID(),
      permissionMode: PermissionMode.ASK,
    });

    const connectorState = async () =>
      (await api.getThreadPanel({ threadId: thread.id })).connectors.find((item) => item.accountId === account.id)
        ?.sessionState;

    expect(await eventually(connectorState, (state) => state === "available", 15_000)).toBe("available");
    const callId = Bun.randomUUIDv7();

    const toolCall = create(AgentToolCallSchema, {
      callId,
      threadId: thread.id,
      turnId: turn.turn!.id,
      connectorAccountId: account.id,
      toolName: post.name,
      argumentsJson: JSON.stringify({ channel: "C123", message: "Thread update" }),
    });

    const waiting = core.connectors.handle(toolCall, f.workerId);
    expect(
      await eventually(
        () => f.query("SELECT id FROM interaction_requests WHERE id=$1 AND status='pending'", [callId]),
        (rows) => rows.length > 0,
      ),
    ).toHaveLength(1);
    expect(posts).toHaveLength(2);
    await api.answerInteraction({ requestId: callId, allow: true });
    const sent = await waiting;
    expect(sent.isError).toBe(false);
    expect(sent.content).toContain("https://app.slack.com/archives/C123/p1234000003");
    expect(JSON.parse((await core.connectors.handle(toolCall, f.workerId)).content)).toEqual(JSON.parse(sent.content));
    expect(posts).toHaveLength(3);
    await f.release("slack-post");
    await f.finished(thread.id, turn.turn!.id);
  }, 45_000);
});

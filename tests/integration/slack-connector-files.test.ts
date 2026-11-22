import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { oauthRedirectUrl } from "../../apps/gateway/src/connectors/catalog.ts";
import { SLACK_DOWNLOAD_ACTION } from "../../apps/gateway/src/connectors/slack-download-tool.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const slackFileId = "F12345";
const downloadUrl = "https://files.slack.com/files-pri/T12345-F12345/download/screen.png";

describe.skipIf(!dockerAvailable)("Slack connector attachments through the gateway and worker", () => {
  const mcp = fakeConnector({ userToken: true });
  let f: HarnessBots;
  let infoReads = 0;
  let beforeDownload: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#12abcd" } })
      .png()
      .toBuffer();

    f = await harnessBots({
      messengerTransport: {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const user = request.headers.get("authorization")?.startsWith("Bearer xoxp-");

          if (!user) return new Response(null, { status: 403 });

          if (request.url === downloadUrl) {
            await beforeDownload?.();

            return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
          }

          if (request.url !== `https://slack.com/api/files.info?file=${slackFileId}`)
            return new Response(null, { status: 404 });
          infoReads++;

          return Response.json({
            ok: true,
            file: { id: slackFileId, name: "screen.png", url_private_download: downloadUrl, size: png.length },
          });
        },
      },
    });
  }, 45_000);

  afterAll(async () => {
    await f?.close();
    mcp.close();
  });

  test("a granted bot imports a forwardable image, and a read-only thread can download it with project access", async () => {
    const { api, core, userId } = f.gw;
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await api.saveConnectorOAuthApp({
      connectorType: "slack",
      ...mcp.registeredApp(oauthRedirectUrl()),
      issuer: mcp.issuer,
    });

    const account = (
      await api.saveConnectorAccount({ connectorType: "slack", name: "Files", url: mcp.url, authKind: "oauth" })
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

    const findTool = async (scope: { projectId: string; workerId: string } | { botId: string }) =>
      (await core.connectors.tools(userId, scope)).find((tool) => tool.remoteName === SLACK_DOWNLOAD_ACTION);

    expect(await findTool({ botId: bot.id })).toBeUndefined();

    const granted = await api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: connected.account!.revision,
      botIds: [bot.id],
    });

    const tool = (await findTool({ botId: bot.id }))!;
    expect(tool.readOnly).toBe(true);
    const thread = await f.thread(Provider.CODEX);
    const projectScope = { projectId: thread.projectId, workerId: f.workerId };
    expect(await findTool(projectScope)).toBeUndefined();

    await f.tool(bot.id, tool.name, { file_id: slackFileId });
    await f.settled(bot.id);

    const imported = await f.query<{ id: string; name: string; sha256: string }>(
      "SELECT id,name,sha256 FROM attachments WHERE bot_id=$1 AND slack_file_id=$2",
      [bot.id, slackFileId],
    );

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe("screen.png");
    expect(infoReads).toBe(1);

    await f.tool(bot.id, "send_message", {
      thread_id: thread.id,
      text: "Inspect it",
      attachment_ids: [imported[0]!.id],
    });
    await f.settled(bot.id);

    const paths = await eventually(
      () =>
        f.query<{ path: string; sha256: string }>(
          "SELECT input->'attachments'->0->>'path' AS path,input->'attachments'->0->>'sha256' AS sha256 FROM turns WHERE thread_id=$1 AND trigger='bot'",
          [thread.id],
        ),
      (rows) => !!rows[0]?.path,
    );

    expect(paths[0]?.sha256).toBe(imported[0]?.sha256);
    const forwarded = await eventually(() => readFile(paths[0]!.path).catch(() => undefined), Boolean);

    expect(forwarded?.subarray(1, 4).toString()).toBe("PNG");

    const projectGrant = await api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: granted.account!.revision,
      botIds: [bot.id],
      projectIds: [thread.projectId],
    });

    expect((await findTool(projectScope))?.name).toBe(tool.name);

    const turn = await api.sendMessage({
      threadId: thread.id,
      text: "HOLD:slack-file",
      clientRequestId: crypto.randomUUID(),
      permissionMode: PermissionMode.READ_ONLY,
    });

    await eventually(
      () => f.query<{ status: string }>("SELECT status FROM turns WHERE id=$1", [turn.turn!.id]),
      (rows) => rows[0]?.status === "running",
    );

    const call = create(AgentToolCallSchema, {
      callId: Bun.randomUUIDv7(),
      threadId: thread.id,
      turnId: turn.turn!.id,
      connectorAccountId: account.id,
      toolName: tool.name,
      argumentsJson: JSON.stringify({ file_id: slackFileId }),
    });

    const result = await core.connectors.handle(call, f.workerId);
    expect(result.isError).toBe(false);
    expect(result.attachments[0]).toMatchObject({ name: "screen.png", sha256: imported[0]?.sha256 });
    expect(result.attachments[0]?.path).toEndWith("/screen.png");
    expect(result.resultJson).not.toContain(downloadUrl);
    expect(result.resultJson).not.toContain("xoxp-");
    expect((await core.connectors.handle(call, f.workerId)).attachments).toEqual(result.attachments);
    expect(infoReads).toBe(2);

    const fetching = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    beforeDownload = () => {
      fetching.resolve();

      return resume.promise;
    };

    const pending = core.connectors.handle({ ...call, callId: Bun.randomUUIDv7() }, f.workerId);

    try {
      await fetching.promise;
      await api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: projectGrant.account!.revision,
        allProjects: false,
        botIds: [bot.id],
      });
    } finally {
      resume.resolve();
    }

    expect((await pending).isError).toBe(true);
    expect((await core.connectors.handle(call, f.workerId)).isError).toBe(true);
    expect(
      await f.query("SELECT id FROM attachments WHERE thread_id=$1 AND turn_id=$2", [thread.id, turn.turn!.id]),
    ).toHaveLength(1);

    await f.release("slack-file");
    await f.finished(thread.id, turn.turn!.id);
  }, 30_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SETTINGS_GUIDE_TOOL, type JsonObject } from "@canopy/domain";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { botContexts } from "./fixtures/bot-probe.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

describe.skipIf(!dockerAvailable)("Canopy Settings guidance through chat", () => {
  let f: HarnessBots;

  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);

  afterAll(async () => {
    await f?.close();
  });

  test("the in-app bot has a read-only source that flags missing client details", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "always");
    await f.send(bot.id, `PROBE_CONTEXT\nTOOL:${SETTINGS_GUIDE_TOOL}\nARGS:{"query":"Appearance"}`);
    const conversation = await f.settled(bot.id);
    const context = botContexts(join(f.dir, "bots.jsonl.context")).at(-1);
    expect(context?.names).toContain(SETTINGS_GUIDE_TOOL);
    expect(context?.instructions).toContain("Never guess a tab, control, or link.");
    expect(conversation.approvals).toHaveLength(0);
    const reply = JSON.parse(conversation.messages.at(-1)!.text.replace(/^TOOL_RESULT:/, ""));
    const result = JSON.parse(reply.result.content[0].text);
    expect(reply.result.isError).toBe(false);
    expect(result).toMatchObject({ status: "unconfirmed", missing: ["client", "client_version"] });
    expect(result).not.toHaveProperty("path");
  });

  test("thread lookup confirms only exact sections for the matching client build", async () => {
    const { gw } = f;
    const projectId = (await gw.api.createProject({ name: "Settings guidance" })).project!.id;

    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app" }))
      .workspace!.id;

    const thread = (
      await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Settings guidance" })
    ).thread!;

    await gw.worker.createdThread(thread.id);

    async function lookup(args: JsonObject) {
      const result = await gw.worker.callTool({ threadId: thread.id, tool: SETTINGS_GUIDE_TOOL, args });
      expect(result.isError).toBe(false);

      return JSON.parse(result.resultJson);
    }

    const version = { client_version: CANOPY_VERSION };

    expect(await lookup({ ...version, client: "desktop", query: "Desktop" })).toMatchObject({
      status: "confirmed_section",
      path: ["Settings", "Desktop"],
      reference: { version: CANOPY_VERSION },
    });

    expect(await lookup({ ...version, client: "web", query: "Desktop" })).not.toHaveProperty("path");
    expect(await lookup({ ...version, client: "ios", query: "Agent tools" })).not.toHaveProperty("path");
    expect(await lookup({ ...version, client: "android", query: "App updates" })).toMatchObject({
      status: "confirmed_section",
      path: ["Settings", "App updates"],
    });
    expect(await lookup({ query: "Appearance", client: "web", client_version: "0.1.0-beta.1" })).toMatchObject({
      status: "unconfirmed",
      reason: expect.stringContaining("different client build"),
    });

    const keyword = await lookup({ ...version, client: "web", query: "sidebar grouping" });
    expect(keyword).toMatchObject({ status: "unconfirmed", search_suggestions: ["General"] });
    expect(keyword).not.toHaveProperty("path");
    expect(await lookup({ ...version, client: "web", query: "Fictional panel" })).toMatchObject({
      status: "unconfirmed",
      search_suggestions: [],
    });
  });
});

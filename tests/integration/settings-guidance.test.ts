import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SETTINGS_GUIDE_TOOL, type SettingsGuideArgs } from "@canopy/domain";
import { findCanopySettings } from "../../apps/gateway/src/core/settings-guide.ts";
import { botContexts } from "./fixtures/bot-probe.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { setModules } from "./support/module-settings.ts";

test("section evidence is scoped to a published client build and carries visibility requirements", () => {
  const version = "0.90.0-nightly.5";

  const lookup = (client: NonNullable<SettingsGuideArgs["client"]>, query: string, clientVersion = version) =>
    findCanopySettings({ client, query, client_version: clientVersion }, version);

  expect(lookup("desktop", "Desktop")).toMatchObject({
    status: "confirmed_section",
    path: ["Settings", "Desktop"],
    reference: { version, channel: "nightly" },
  });
  expect(lookup("web", "Desktop")).not.toHaveProperty("path");
  expect(lookup("ios", "Agent tools")).toMatchObject({
    status: "conditional_section",
    path: ["Settings", "Agent tools"],
    conditions: ["The connected gateway must support Agent tools."],
  });
  expect(lookup("android", "App updates")).toMatchObject({
    status: "confirmed_section",
    path: ["Settings", "App updates"],
  });
  expect(lookup("web", "Linked computers")).toMatchObject({
    status: "conditional_section",
    path: ["Settings", "Linked computers"],
    conditions: ["The connected gateway must support linked computers."],
  });
  expect(lookup("desktop", "Projects")).toMatchObject({
    status: "conditional_section",
    conditions: ["The Threads module must be enabled.", "The connected gateway must support Projects."],
  });
  expect(lookup("web", "Appearance", "0.6.0-beta.1")).toMatchObject({
    status: "unconfirmed",
    reason: expect.stringContaining("different client build"),
  });

  const keyword = lookup("web", "sidebar grouping");
  expect(keyword).toMatchObject({ status: "unconfirmed", search_suggestions: ["Threads"] });
  expect(keyword).not.toHaveProperty("path");
  expect(lookup("ios", "in-app alerts").search_suggestions).toEqual(["Notifications"]);
  expect(lookup("desktop", "gateway updates").search_suggestions).toEqual(["App updates"]);
  expect(lookup("web", "CLI updates").search_suggestions).toEqual(["Workers"]);
  expect(lookup("web", "Fictional panel")).toMatchObject({ status: "unconfirmed", search_suggestions: [] });
});

test("Network access purpose is available independently of verified navigation", () => {
  const version = "0.90.0-nightly.5";
  const query = "Network access";
  const sectionPurpose = expect.stringContaining("It has no effect on outbound internet access from an agent process");

  for (const args of [
    { query },
    { query, client: "desktop" },
    { query, client_version: version },
    { query, client: "desktop", client_version: "0.6.0-beta.1" },
  ] satisfies SettingsGuideArgs[]) {
    const result = findCanopySettings(args, version);
    expect(result).toMatchObject({ status: "unconfirmed", section_purpose: sectionPurpose });
    expect(result).not.toHaveProperty("path");
  }

  expect(findCanopySettings({ query, client: "desktop", client_version: version }, version)).toMatchObject({
    status: "conditional_section",
    path: ["Settings", "Network access"],
    section_purpose: sectionPurpose,
    conditions: ["The connected gateway must support Network access."],
  });
  expect(
    findCanopySettings(
      { query: "allow agent outbound internet access to GitHub", client: "desktop", client_version: version },
      version,
    ),
  ).toMatchObject({ status: "unconfirmed", search_suggestions: [] });
});

describe.skipIf(!dockerAvailable)("Canopy Settings guidance through chat", () => {
  let f: HarnessBots;

  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);

  afterAll(async () => {
    await f?.close();
  });

  test("the thread reports uncertainty for an unidentifiable development build", async () => {
    const { gw } = f;
    const projectId = (await gw.api.createProject({ name: "Settings guidance" })).project!.id;

    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app" }))
      .workspace!.id;

    const thread = (
      await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Settings guidance" })
    ).thread!;

    await gw.worker.createdThread(thread.id);

    const reply = await gw.worker.callTool({
      threadId: thread.id,
      tool: SETTINGS_GUIDE_TOOL,
      args: { client: "desktop", query: "Desktop", client_version: "0.0.0-dev" },
    });

    expect(reply.isError).toBe(false);
    const result = JSON.parse(reply.resultJson);
    expect(result).toMatchObject({
      status: "unconfirmed",
      reason: expect.stringContaining("does not identify a published client build"),
    });
    expect(result).not.toHaveProperty("path");

    const withoutClient = await gw.worker.callTool({
      threadId: thread.id,
      tool: SETTINGS_GUIDE_TOOL,
      args: { query: "Network access" },
    });

    expect(withoutClient.isError).toBe(false);
    const network = JSON.parse(withoutClient.resultJson);
    expect(network).toMatchObject({
      status: "unconfirmed",
      missing: ["client", "client_version"],
      section_purpose: expect.stringContaining("manages incoming connections to Canopy"),
    });
    expect(network).not.toHaveProperty("path");
  });

  test("the in-app bot can verify guidance with Web access and Threads disabled", async () => {
    await setModules(f.gw, "bots");
    const bot = await f.add(Provider.CODEX, f.workerId, "always");
    await f.gw.api.updateBot({
      botId: bot.id,
      configuration: { ...bot.configuration!, webAccess: false },
    });
    await f.send(bot.id, `PROBE_CONTEXT\nTOOL:${SETTINGS_GUIDE_TOOL}\nARGS:{"query":"Appearance"}`);

    const conversation = await f.settled(bot.id);
    const context = botContexts(join(f.dir, "bots.jsonl.context")).at(-1);
    expect(context?.names).toContain(SETTINGS_GUIDE_TOOL);
    expect(context?.names).not.toContain("get_settings");
    expect(context?.instructions).toContain("Web access is disabled.");
    expect(context?.instructions).toContain("Describe conditional sections with their visibility requirements.");
    expect(context?.instructions).toContain("Never guess a tab, control, or link.");
    expect(conversation.approvals).toHaveLength(0);

    const reply = JSON.parse(conversation.messages.at(-1)!.text.replace(/^TOOL_RESULT:/, ""));
    const result = JSON.parse(reply.result.content[0].text);
    expect(reply.result.isError).toBe(false);
    expect(result).toMatchObject({ status: "unconfirmed", missing: ["client", "client_version"] });
    expect(result).not.toHaveProperty("path");
  });
});

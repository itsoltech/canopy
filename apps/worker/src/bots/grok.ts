import { GrokClient } from "@canopy/grok-acp";
import { statSync } from "node:fs";
import { join } from "node:path";
import { grokLaunch } from "../providers/grok/launch.ts";
import { GrokEventMapper } from "../providers/grok/mapping.ts";
import { grokStopReason, grokTranscriptPath } from "../providers/grok/transcript.ts";
import { botPrompt } from "./session.ts";
import { BotHarnessFailure, type BotHarnessContext } from "./types.ts";

/** ACP owns inference; the only tools exposed by the curated agent are Canopy MCP. */
export async function runGrokBot(ctx: BotHarnessContext): Promise<void> {
  const { input, session, signal } = ctx;

  const launch = grokLaunch({
    dataDir: session.home,
    executable: ctx.executable,
    profile: ctx.profile,
    model: input.model,
    effort: input.effort,
    readOnly: true,
    linkDeviceLogin: session.linkLogin,
    bot: { cwd: session.cwd, instructions: input.instructions, sourceHome: session.sourceHome },
  });

  const client = new GrokClient({
    ...launch.options,
    // Every CLI permission is denied. Canopy MCP approvals are enforced independently in the gateway.
    callbacks: { requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
  });

  let id = "";

  const cancel = () => {
    if (id) void client.cancel(id).catch(() => undefined);
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    signal.throwIfAborted();
    const info = await client.initialize();
    const hasImages = input.attachments.length > 0 || input.historyAttachments.length > 0;

    if (hasImages && !info.agentCapabilities?.promptCapabilities?.image)
      throw new BotHarnessFailure("IMAGE_UNAVAILABLE", "Update the Grok CLI to receive images.");

    if (input.tools.length && !info.agentCapabilities?.mcpCapabilities?.http)
      throw new BotHarnessFailure("MCP_UNAVAILABLE");

    const servers = input.tools.length
      ? [
          {
            type: "http" as const,
            name: "canopy",
            url: ctx.mcp.url,
            headers: Object.entries(ctx.mcp.headers).map(([name, value]) => ({ name, value })),
          },
        ]
      : [];

    const resumed =
      session.id && info.agentCapabilities?.loadSession
        ? await client.loadSession(session.id, session.cwd, servers).catch((error) => {
            if (/session missing|not found|no such file/i.test(error.message)) return undefined;
            throw error;
          })
        : undefined;

    const opened = resumed ?? (await client.newSession(session.cwd, servers));
    id = opened.sessionId;
    session.save(id);

    const root = join(session.home, "grok", ctx.profile.id, "sessions");
    const transcript = grokTranscriptPath(root, id);

    await ctx.noteHarness({
      harness: "grok",
      transcript: root,
      sessionId: id,
      offset: transcript ? statSync(transcript).size : 0,
      providerTurn: "",
    });

    if (opened.models && opened.models.currentModelId !== input.model) await client.setModel(id, input.model);
    signal.throwIfAborted();
    const mapper = new GrokEventMapper(input.turnId, session.cwd);
    let complete = false;

    for await (const event of client.prompt(id, [
      { type: "text", text: `${input.instructions}\n\n${botPrompt(input, Boolean(resumed))}` },
      ...(await ctx.images(Boolean(resumed))).map((image) => ({
        type: "image" as const,
        data: Buffer.from(image.data).toString("base64"),
        mimeType: image.mimeType,
      })),
    ])) {
      signal.throwIfAborted();

      if (event.type === "update") {
        for (const init of mapper.update(event.update)) await ctx.record(init);
      } else {
        if (event.stopReason !== "end_turn") throw new BotHarnessFailure(grokStopReason(event.stopReason));
        complete = true;
      }
    }

    for (const init of mapper.finish()) await ctx.record(init);

    if (!complete) throw new BotHarnessFailure("process_exit");
  } finally {
    signal.removeEventListener("abort", cancel);
    await client.dispose();
    launch.cleanup();
  }
}

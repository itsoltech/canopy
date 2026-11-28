import type { JsonValue } from "@canopy/domain";
import { runProcess } from "@canopy/process-governor";
import { z } from "zod";
import { BrowserCdp } from "./browser-cdp.ts";
import { toolArgv, type ToolEnv } from "./paths.ts";

const endpoint = z.object({ success: z.literal(true), data: z.object({ cdpUrl: z.string() }) });
const inactive = z.object({ success: z.literal(false), error: z.literal("Browser not launched") });

const tabList = z.object({
  success: z.literal(true),
  data: z.object({ tabs: z.array(z.object({ targetId: z.string(), active: z.boolean() })) }),
});

/** The queue that orders the agent's browser calls with the owner's Preview navigation and fills. */
export function browserSessionQueue(session: string): string {
  return `browser-mcp:${session}`;
}

export type BrowserCommand = (args: string[], signal: AbortSignal) => Promise<JsonValue>;

/** One agent-browser command for this session, outside its MCP server. Its lifetime is the caller's signal only. */
export function browserCommand(cli: string, env: ToolEnv, session: string): BrowserCommand {
  return async (args, signal) => {
    const result = await runProcess(
      {
        argv: toolArgv(cli, ["--session", session, "--headed", "false", "--json", ...args], env),
        env,
        signal,
        timeoutMs: 3_000,
        maxBytes: 256 * 1024,
      },
      { kind: "utility", maxQueueMs: 2_500, signal },
    );

    return z.json().parse(JSON.parse(result.stdout));
  };
}

/** Chrome's DevTools address, undefined when the session has no browser running. Other failures throw. */
export async function browserEndpoint(command: BrowserCommand, signal: AbortSignal): Promise<string | undefined> {
  const result = await command(["get", "cdp-url"], signal);
  const address = endpoint.safeParse(result);

  if (address.success) return address.data.data.cdpUrl;

  if (inactive.safeParse(result).success) return undefined;

  throw new Error("Agent Browser did not report its Chrome address.");
}

/** A private connection to the session's active tab. */
export async function attachActiveTab(
  command: BrowserCommand,
  signal: AbortSignal,
  maxMessageBytes?: number,
): Promise<BrowserCdp | undefined> {
  const url = await browserEndpoint(command, signal);

  if (!url) return;
  const tabs = tabList.parse(await command(["tab", "list"], signal));
  const current = tabs.data.tabs.find((tab) => tab.active);

  return current ? BrowserCdp.attach(url, current.targetId, signal, maxMessageBytes) : undefined;
}

/** Private connections to every tab of the session: a capture may show any of them. */
export async function attachAllTabs(
  command: BrowserCommand,
  signal: AbortSignal,
  maxMessageBytes?: number,
): Promise<BrowserCdp[]> {
  const url = await browserEndpoint(command, signal);

  if (!url) return [];
  const tabs = tabList.parse(await command(["tab", "list"], signal)).data.tabs;
  const attached: BrowserCdp[] = [];

  try {
    for (const tab of tabs) attached.push(await BrowserCdp.attach(url, tab.targetId, signal, maxMessageBytes));
  } catch (error) {
    for (const cdp of attached) cdp.close();
    throw error;
  }

  return attached;
}

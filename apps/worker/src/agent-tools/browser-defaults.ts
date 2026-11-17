import type { BrowserSessionDefaults } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { z } from "zod";
import { toolArgv, type ToolEnv } from "./paths.ts";
import { serializeAgentTool } from "./queue.ts";

const runtime = z.object({ data: z.object({ runtime: z.object({ browserLaunched: z.boolean() }).nullable() }) });
const result = z.object({ success: z.boolean(), data: z.json().optional() });

const passiveTools = new Set([
  "agent_browser_doctor",
  "agent_browser_close",
  "agent_browser_session_list",
  "agent_browser_session_info",
]);

/** Only authorized active calls reach this hook; native state survives bridge and worker restarts. */
export function browserDefaultsInitializer(
  executable: string,
  env: ToolEnv,
  session: string,
  defaults: BrowserSessionDefaults | undefined,
): (tool: string, signal: AbortSignal) => Promise<void> {
  return async (tool, signal) => {
    if (
      !defaults ||
      (!defaults.colorScheme && defaults.viewportWidth === undefined && defaults.viewportHeight === undefined) ||
      passiveTools.has(tool)
    )
      return;

    await serializeAgentTool(`browser-defaults:${session}`, async () => {
      signal.throwIfAborted();

      const command = async (args: string[]) => {
        const output = await runProcess(
          {
            argv: toolArgv(executable, ["--json", "--session", session, "--headed", "false", ...args], env),
            env,
            signal,
            timeoutMs: 60_000,
            maxBytes: 512 * 1024,
          },
          { kind: "utility", maxQueueMs: 2_500, signal },
        );

        const parsed = result.parse(JSON.parse(output.stdout));

        if (output.code !== 0 || !parsed.success) throw new Error("Browser session defaults could not be initialized");

        return parsed;
      };

      const info = runtime.parse(await command(["session", "info"]));

      if (info.data.runtime?.browserLaunched) return;
      const color = defaults.colorScheme ? ["--color-scheme", defaults.colorScheme] : [];
      const dimensions = defaults.viewportWidth !== undefined && defaults.viewportHeight !== undefined;

      // The viewport command launches headless with the selected media before the requested navigation.
      await command([
        ...color,
        ...(dimensions
          ? ["set", "viewport", String(defaults.viewportWidth), String(defaults.viewportHeight)]
          : ["open", "about:blank"]),
      ]);
    });
  };
}

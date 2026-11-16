import { AgentTool } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { z } from "zod";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { agentToolVersion, type AgentToolProbe } from "./probe.ts";
import { toolArgv, toolCandidates, toolEnvironment } from "./paths.ts";
import { AGENT_TOOL_SPECS, type AgentToolSpec } from "./specs.ts";
import { serializeAgentTool } from "./queue.ts";

const envelope = z.object({
  success: z.boolean().optional(),
  ok: z.boolean().optional(),
  data: z.json().optional(),
  error: z
    .union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })])
    .nullable()
    .optional(),
});

/** Pinned CLI grammar: browser 0.43.0, desktop 1.3.1, device 0.21.37. No readiness probes. */
async function closeTool(spec: AgentToolSpec, session: string, probe: AgentToolProbe): Promise<void> {
  const source = probe.env ?? process.env;
  const env = toolEnvironment(source);
  const candidates = toolCandidates(spec, source, probe.platform ?? process.platform, probe.dataDir, probe.which);

  if (!candidates.length) return;
  let executable = "";

  for (const candidate of candidates.slice(0, 8)) {
    const version = await (probe.version?.(candidate) ?? agentToolVersion(candidate, source));

    if ("line" in version && version.line.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/)?.[0] === spec.version) {
      executable = candidate;
      break;
    }
  }

  if (!executable) throw new Error(`${spec.label} cleanup requires version ${spec.version}`);
  const { secrets } = installEnv(source);

  const command = async (args: string[], missingSession = false) => {
    const result = await runProcess(
      { argv: toolArgv(executable, args, env), env, timeoutMs: 20_000, maxBytes: 512 * 1024 },
      { kind: "utility", maxQueueMs: 2_500 },
    );

    const parsed = envelope.parse(JSON.parse(result.stdout));

    if (result.code !== 0 || parsed.success === false || parsed.ok === false) {
      const error = z.object({ code: z.string(), message: z.string().optional() }).safeParse(parsed.error);

      if (missingSession && error.success && error.data.code === "SESSION_NOT_FOUND") return null;
      throw new Error(redactLine(`${spec.label}: ${JSON.stringify(parsed.error ?? "cleanup failed")}`, secrets));
    }

    return parsed.data ?? null;
  };

  if (spec.tool === AgentTool.BROWSER) {
    // session list walks existing daemon registrations; unlike close it never starts a daemon.
    const data = z.object({ sessions: z.array(z.string()) }).parse(await command(["--json", "session", "list"]));

    if (!data.sessions.includes(session)) return;
    const closed = await command(["--json", "--session", session, "close"]);
    z.object({ closed: z.literal(true) }).parse(closed);
  } else if (spec.tool === AgentTool.DESKTOP) {
    // Desktop is daemonless. Disable only its persistent cursor; session end permanently seals the namespace.
    const data = z
      .object({ sessions: z.array(z.object({ session_id: z.string(), ended_at: z.number().nullable().optional() })) })
      .parse(await command(["session", "list"]));

    if (data.sessions.some((item) => item.session_id === session && item.ended_at == null))
      await command(["--session", session, "cursor-overlay", "disable"]);
  } else {
    // This shared daemon is not owned by a thread. Its offline status avoids starting an unused daemon.
    const status = z
      .object({ state: z.enum(["running", "stopped", "unreadable", "invalid"]) })
      .parse(await command(["--json", "daemon", "status"]));

    if (status.state === "stopped") return;

    if (status.state !== "running") throw new Error("agent-device daemon registration cannot be read");
    // No app/device positional: release only this named session and its helpers/managed web browser.
    await command(["--json", "--session", session, "close"], true);
  }
}

export async function closeAgentToolSession(session: string, probe: AgentToolProbe): Promise<void> {
  const failures: Error[] = [];

  for (const spec of AGENT_TOOL_SPECS) {
    try {
      await serializeAgentTool("operations", () => closeTool(spec, session, probe));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(`${spec.label} cleanup failed`));
    }
  }

  if (failures.length) throw new AggregateError(failures, "Automation session cleanup failed");
}

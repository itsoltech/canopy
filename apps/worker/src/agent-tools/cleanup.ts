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

async function cleanupCommand(spec: AgentToolSpec, probe: AgentToolProbe) {
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

  return async (args: string[], missingSession = false) => {
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
}

type CleanupCommand = NonNullable<Awaited<ReturnType<typeof cleanupCommand>>>;

/** Read active sessions once after all the threads in this batch have drained their native operations. */
async function activeSessions(tool: AgentTool, command: CleanupCommand, requested: Set<string>) {
  if (tool === AgentTool.BROWSER) {
    const data = z.object({ sessions: z.array(z.string()) }).parse(await command(["--json", "session", "list"]));

    return data.sessions;
  }

  if (tool === AgentTool.DESKTOP) {
    const data = z
      .object({ sessions: z.array(z.object({ session_id: z.string(), ended_at: z.number().nullable().optional() })) })
      .parse(await command(["session", "list"]));

    return data.sessions.filter((item) => item.ended_at == null).map((item) => item.session_id);
  }

  // Offline status never starts the shared device daemon. A named list includes local sessions across workspaces.
  const status = z
    .object({ state: z.enum(["running", "stopped", "unreadable", "invalid"]) })
    .parse(await command(["--json", "daemon", "status"]));

  if (status.state === "stopped") return [];

  if (status.state !== "running") throw new Error("agent-device daemon registration cannot be read");
  const [session] = requested;

  if (requested.size <= 1 || !session) return requested;

  const data = z
    .object({ sessions: z.array(z.object({ name: z.string() })) })
    .parse(await command(["--json", "--session", session, "session", "list"]));

  return data.sessions.map((item) => item.name);
}

async function closeSessions(spec: AgentToolSpec, requested: Set<string>, probe: AgentToolProbe) {
  const failures = new Map<string, Error>();
  const command = await cleanupCommand(spec, probe);

  if (!command) return failures;

  for (const session of new Set(await activeSessions(spec.tool, command, requested))) {
    if (!requested.has(session)) continue;

    try {
      if (spec.tool === AgentTool.DESKTOP) {
        // Session end permanently seals this namespace. Preserve its history and ability to reopen.
        await command(["--session", session, "cursor-overlay", "disable"]);
      } else {
        const closed = await command(["--json", "--session", session, "close"], spec.tool === AgentTool.DEVICE);

        if (spec.tool === AgentTool.BROWSER) z.object({ closed: z.literal(true) }).parse(closed);
      }
    } catch (error) {
      failures.set(session, error instanceof Error ? error : new Error(`${spec.label} cleanup failed`));
    }
  }

  return failures;
}

/** Each tool gets one inventory per batch. Requests that drain later start a fresh inventory. */
export class AgentToolCleanup {
  readonly #queued = new Map<AgentTool, { sessions: Set<string>; result: Promise<Map<string, Error>> }>();

  constructor(readonly probe: () => AgentToolProbe) {}

  async close(session: string): Promise<void> {
    const results = await Promise.allSettled(AGENT_TOOL_SPECS.map((spec) => this.#close(spec, session)));
    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Automation session cleanup failed",
      );
  }

  async #close(spec: AgentToolSpec, session: string): Promise<void> {
    let batch = this.#queued.get(spec.tool);

    if (!batch) {
      const sessions = new Set<string>();

      const result = serializeAgentTool("operations", () => {
        this.#queued.delete(spec.tool);

        return closeSessions(spec, sessions, this.probe());
      });

      batch = { sessions, result };
      this.#queued.set(spec.tool, batch);
    }

    batch.sessions.add(session);
    const failure = (await batch.result).get(session);

    if (failure) throw failure;
  }
}

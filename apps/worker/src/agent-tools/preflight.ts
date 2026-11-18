import { z } from "zod";
import { Match } from "effect";
import { AgentTool } from "@canopy/contracts";
import { ProcessTimeoutError, runProcess } from "@canopy/process-governor";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { toolArgv, toolEnvironment, type ToolEnv } from "./paths.ts";
import type { AgentToolSpec } from "./specs.ts";
import { agentToolScopeArgs, type AgentToolScope } from "./scope.ts";

export interface ToolReadiness {
  readonly ready: boolean;
  readonly detail: string;
}

const permission = z.object({ state: z.enum(["granted", "not_required", "denied", "unknown"]) });

const desktopStatus = z.object({
  ok: z.literal(true),
  data: z.object({
    platform: z.string(),
    supported_surfaces: z.array(z.string()).min(1),
    permissions: z.object({ accessibility: permission, screen_recording: permission }),
  }),
});

const browserDoctor = z.object({
  success: z.boolean(),
  checks: z.array(z.object({ id: z.string(), status: z.string(), message: z.string() })),
});

const deviceDoctor = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(["pass", "warn", "fail", "info"]),
    checks: z.array(z.object({ id: z.string(), status: z.string(), summary: z.string() })),
  }),
});

function desktopReady(stdout: string, platform: NodeJS.Platform): ToolReadiness {
  const status = desktopStatus.safeParse(JSON.parse(stdout));

  if (!status.success) return { ready: false, detail: "Desktop status did not confirm an accessibility session" };
  const { permissions } = status.data.data;

  const matches =
    status.data.data.platform ===
    Match.value(platform).pipe(
      Match.when("win32", () => "windows"),
      Match.when("darwin", () => "macos"),
      Match.orElse((value) => value),
    );

  const allowed = (state: string) => state === "granted" || state === "not_required";

  if (!matches) return { ready: false, detail: "Desktop status reported a different operating system" };

  if (!allowed(permissions.accessibility.state))
    return { ready: false, detail: "Grant Accessibility permission and run the worker in your graphical session" };

  // Screen Recording is a macOS TCC permission. Linux and Windows may report
  // the field as unknown because those platforms do not have this permission.
  if (platform === "darwin" && !allowed(permissions.screen_recording.state))
    return { ready: false, detail: "Grant Screen Recording permission for desktop screenshots" };

  return { ready: true, detail: "ready" };
}

function browserReady(stdout: string): ToolReadiness {
  const doctor = browserDoctor.safeParse(JSON.parse(stdout));

  if (!doctor.success) return { ready: false, detail: "Browser doctor returned an unsupported response" };
  const failure = doctor.data.checks.find((check) => check.status === "fail");

  const launched = doctor.data.checks.some(
    (check) => check.id === "launch.elapsed" && ["pass", "warn"].includes(check.status),
  );

  if (failure) return { ready: false, detail: failure.message };

  if (!doctor.data.success || !launched)
    return { ready: false, detail: "Browser runtime launch was not verified; run agent-browser doctor" };

  return { ready: true, detail: "ready" };
}

function deviceReady(stdout: string): ToolReadiness {
  const doctor = deviceDoctor.safeParse(JSON.parse(stdout));

  if (!doctor.success) return { ready: false, detail: "Device doctor returned an unsupported response" };
  const failure = doctor.data.data.checks.find((check) => check.status === "fail");
  const device = doctor.data.data.checks.some((check) => check.id === "device" && check.status === "pass");

  if (failure) return { ready: false, detail: failure.summary };

  if (doctor.data.data.status === "fail" || !device)
    return { ready: false, detail: "No usable device was confirmed; run agent-device doctor" };

  return { ready: true, detail: "ready" };
}

/** Readiness uses the CLI's own runtime checks, never an install marker or a version string alone. */
export async function preflightAgentTool(
  spec: AgentToolSpec,
  path: string,
  sourceEnv: ToolEnv,
  platform: NodeJS.Platform,
  scope: AgentToolScope = {},
  signal?: AbortSignal,
): Promise<ToolReadiness> {
  const args =
    spec.tool === AgentTool.DESKTOP
      ? ["status"]
      : spec.tool === AgentTool.BROWSER
        ? ["doctor", "--offline", "--json"]
        : ["doctor", "--json", ...agentToolScopeArgs(spec.tool, scope)];

  const { secrets } = installEnv(sourceEnv);
  const env = toolEnvironment(sourceEnv, platform);

  try {
    const input = {
      argv: toolArgv(path, args, env, platform),
      env,
      timeoutMs: 12_000,
      maxBytes: 256 * 1024,
      ...(signal && { signal }),
    };

    const result = await runProcess(input, { kind: "probe", maxQueueMs: 2_500, ...(signal && { signal }) });

    const readiness =
      spec.tool === AgentTool.DESKTOP
        ? desktopReady(result.stdout, platform)
        : spec.tool === AgentTool.BROWSER
          ? browserReady(result.stdout)
          : deviceReady(result.stdout);

    return {
      ready: result.code === 0 && readiness.ready,
      detail:
        result.code !== 0 && readiness.ready ? `${spec.label} preflight failed` : redactLine(readiness.detail, secrets),
    };
  } catch (error) {
    return {
      ready: false,
      detail:
        error instanceof ProcessTimeoutError
          ? "Runtime check exceeded its time or output limit"
          : "Runtime check did not return a valid response",
    };
  }
}

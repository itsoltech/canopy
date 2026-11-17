import { AgentTool, type RunAgentTool } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { z } from "zod";
import type { AgentTools } from "../agent-tools/index.ts";
import { toolArgv } from "../agent-tools/paths.ts";
import { serializeAgentTool } from "../agent-tools/queue.ts";

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

type Resolved = Awaited<ReturnType<AgentTools["resolvePreviewScope"]>>;

const envelope = z.object({
  ok: z.boolean().optional(),
  success: z.boolean().optional(),
  data: z.json().optional(),
  error: z
    .union([z.string(), z.object({ message: z.string().optional() })])
    .nullable()
    .optional(),
});

export class PreviewRuntime {
  readonly scope: RunAgentTool;
  readonly #resolved: Resolved;
  readonly #signal: AbortSignal;
  #deviceName = "";

  constructor(resolved: Resolved, signal: AbortSignal) {
    this.scope = resolved.scope;
    this.#resolved = resolved;
    this.#signal = signal;
  }

  redact(detail: string): string {
    return this.#resolved.redact(detail);
  }

  selectDeviceName(name: string): void {
    this.#deviceName = name;
  }

  get devicePlatform(): string {
    return this.#resolved.devicePlatform ?? "";
  }

  canPreviewDevice(deviceId: string, platform: string): boolean {
    return this.#resolved.canPreviewDevice?.(deviceId, platform) ?? true;
  }

  get env() {
    return this.#resolved.env;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  async command(
    args: readonly string[],
    options: { cleanup?: boolean; timeoutMs?: number; input?: string } = {},
  ): Promise<JsonValue> {
    const signal = options.cleanup ? AbortSignal.timeout(2_000) : this.#signal;
    signal.throwIfAborted();

    if (this.scope.tool === AgentTool.BROWSER && !options.cleanup && ["open", "set"].includes(args[0] ?? ""))
      await this.#resolved.initializeBrowser?.("agent_browser_open", signal);

    const execute = () =>
      serializeAgentTool(
        "operations",
        async () => {
          signal.throwIfAborted();

          const result = await runProcess(
            {
              argv: toolArgv(this.#resolved.executable, [...this.#prefix(args), ...args], this.#resolved.env),
              env: this.#resolved.env,
              signal,
              timeoutMs: options.timeoutMs ?? 12_000,
              maxBytes: 512 * 1024,
              ...(options.input !== undefined && { input: options.input }),
            },
            { kind: "utility", maxQueueMs: 1_000, signal },
          );

          let parsed: z.infer<typeof envelope>;

          try {
            parsed = envelope.parse(JSON.parse(result.stdout));
          } catch {
            throw new Error(this.redact(result.stderr || result.stdout || "Preview command returned invalid JSON"));
          }

          if (result.code !== 0 || parsed.ok === false || parsed.success === false) {
            const error = z.string().safeParse(parsed.error);
            const object = z.object({ message: z.string() }).safeParse(parsed.error);
            throw new Error(
              this.redact(error.success ? error.data : object.success ? object.data.message : "Preview command failed"),
            );
          }

          return parsed.data ?? null;
        },
        1_000,
      );

    return this.scope.tool === AgentTool.DEVICE && !["devices", "session"].includes(args[0] ?? "")
      ? this.useDevice(execute)
      : execute();
  }

  useDevice<T>(work: () => Promise<T>): Promise<T> {
    return this.#resolved.useDevice(this.#signal, work);
  }

  #prefix(args: readonly string[]): string[] {
    const { tool, session, platform, deviceId } = this.scope;

    if (tool === AgentTool.BROWSER) return ["--json", "--session", session, "--headed", "false"];

    if (tool === AgentTool.DESKTOP) return ["--session", session, "--headed"];

    if (["devices", "session"].includes(args[0] ?? "")) return ["--json", "--session", session];
    const prefix = ["--json", "--session", session, ...(platform ? ["--platform", platform] : [])];

    if (!deviceId) return prefix;

    const flag = ["ios", "macos", "apple"].includes(platform)
      ? "--udid"
      : ["android", "harmonyos", "vega"].includes(platform)
        ? "--serial"
        : "--device";

    return [...prefix, flag, flag === "--device" ? this.#deviceName || deviceId : deviceId];
  }
}

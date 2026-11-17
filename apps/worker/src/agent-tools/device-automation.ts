import type { DeviceSessionDefaults, RunAgentTool } from "@canopy/contracts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import { DevicePool } from "./device-pool.ts";
import { createDeviceBackend } from "./device-backend.ts";
import { managedDeviceMcp } from "./device-mcp.ts";
import type { AgentToolProbe } from "./probe.ts";
import { agentToolSession } from "./scope.ts";

/** Shared across all harness bridges and Preview clients on this worker. */
export class DeviceAutomation {
  readonly #pool: DevicePool;
  #recovering: Promise<void> | undefined;

  constructor(dataDir: string, probe: () => AgentToolProbe) {
    this.#pool = new DevicePool({ dataDir, backend: createDeviceBackend(probe) });
  }

  recover(): Promise<void> {
    this.#recovering ??= this.#pool.recover().catch((error: Error) => {
      this.#recovering = undefined;
      throw error;
    });

    return this.#recovering;
  }

  managed(session: string, defaults?: DeviceSessionDefaults): NonNullable<LocalAutomationServer["managed"]> {
    const managed = managedDeviceMcp(this.#pool, session, () => this.#pool.release(session), defaults);

    return {
      tools: managed.tools,
      ...(managed.catalog && { catalog: managed.catalog }),
      call: async (...args) => {
        try {
          await this.recover();

          return await managed.call(...args);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : "Device reservation failed" }],
          };
        }
      },
    };
  }

  fence(threadId: string): void {
    this.#pool.fence(agentToolSession(threadId));
  }

  open(threadId: string): void {
    this.#pool.open(agentToolSession(threadId));
  }

  release(threadId: string): Promise<void> {
    return this.#pool.release(agentToolSession(threadId));
  }

  close(): Promise<void> {
    return this.#pool.close();
  }

  currentPlatform(session: string): string | undefined {
    return this.#pool.current(agentToolSession(session))?.platform;
  }

  canPreview(session: string, deviceId: string, platform: string): boolean {
    return this.#pool.canPreview(agentToolSession(session), deviceId, platform);
  }

  async use<T>(
    scope: RunAgentTool,
    signal: AbortSignal,
    work: () => Promise<T>,
    defaults?: DeviceSessionDefaults,
  ): Promise<T> {
    await this.recover();
    const session = agentToolSession(scope.session);

    const device = await this.#pool.acquire(
      session,
      {
        ...((scope.platform || (!scope.deviceId && !this.#pool.current(session) && defaults?.platform)) && {
          platform: scope.platform || defaults?.platform,
        }),
        ...(scope.deviceId && { deviceId: scope.deviceId }),
        boot: false,
        wait: false,
        timeoutMs: 15_000,
      },
      signal,
    );

    scope.platform = device.platform;
    scope.deviceId = device.id;

    return this.#pool.use(session, device.id, work);
  }
}

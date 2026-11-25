import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, type SessionResult } from "@canopy/acp";
import { PermissionMode } from "@canopy/contracts";
import { closeAcpResources } from "../acp/cleanup.ts";
import { antigravityLaunch, supportsAntigravityVersion, type AntigravityInstance } from "./launch.ts";

/** Use the turn's login and isolation policy without sending a prompt or keeping a conversation. */
export async function withAntigravitySession<T>(
  instance: AntigravityInstance,
  read: (client: AcpClient, session: SessionResult) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const cwd = mkdtempSync(join(tmpdir(), "canopy-antigravity-probe-"));
  let launch: ReturnType<typeof antigravityLaunch> | undefined;
  let client: AcpClient | undefined;
  const abort = () => void client?.dispose().catch(() => {});

  try {
    launch = antigravityLaunch({ ...instance, cwd, scratch: true, permissionMode: PermissionMode.ASK });
    client = new AcpClient(launch.options);
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    const info = await client.initialize();

    if (!supportsAntigravityVersion(info.agentInfo?.version))
      throw new Error("Antigravity CLI 1.5.16 or newer in the 1.x series is required.");
    const session = await client.newSession(cwd);
    signal?.throwIfAborted();

    return await read(client, session);
  } finally {
    signal?.removeEventListener("abort", abort);
    await closeAcpResources([
      () => client?.dispose(),
      launch?.cleanup,
      () => rmSync(cwd, { recursive: true, force: true }),
    ]);
  }
}

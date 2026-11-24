import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, sessionSelect } from "@canopy/acp";
import { PermissionMode } from "@canopy/contracts";
import { closeAcpResources } from "../acp/cleanup.ts";
import type { ModelInit } from "../models.ts";
import { antigravityLaunch, supportsAntigravityVersion, type AntigravityInstance } from "./launch.ts";

/** Query the same authenticated ACP session configuration used to start a turn,
 * without sending a prompt. agy returns the thinking levels for the selected
 * model only. Selection writes to the probe's disposable CLI settings. */
export async function listAntigravityModels(instance: AntigravityInstance): Promise<{ models: ModelInit[] }> {
  const cwd = mkdtempSync(join(tmpdir(), "canopy-antigravity-catalog-"));
  let launch: ReturnType<typeof antigravityLaunch> | undefined;
  let client: AcpClient | undefined;

  try {
    launch = antigravityLaunch({ ...instance, cwd, scratch: true, permissionMode: PermissionMode.ASK });
    client = new AcpClient(launch.options);
    const info = await client.initialize();

    if (!supportsAntigravityVersion(info.agentInfo?.version))
      throw new Error("Antigravity CLI 1.5.16 or newer in the 1.x series is required.");
    const session = await client.newSession(cwd);
    const select = sessionSelect(session, "model");

    if (!select) throw new Error("Antigravity did not report a session model selector.");

    const models: ModelInit[] = [];

    for (const model of select.options) {
      const isDefault = model.value === select.currentValue;
      const config = isDefault ? session : await client.setConfigOption(session.sessionId, select.id, model.value);

      if (sessionSelect(config, "model")?.currentValue !== model.value)
        throw new Error("Antigravity did not apply the requested catalog model.");
      const effort = sessionSelect(config, "thought_level");
      models.push({
        id: model.value,
        displayName: model.name,
        description: model.description ?? "",
        isDefault,
        efforts: effort?.options.map((choice) => choice.value) ?? [],
        ...(isDefault && effort?.currentValue && { defaultEffort: effort.currentValue }),
      });
    }

    return { models };
  } finally {
    await closeAcpResources([
      () => client?.dispose(),
      launch?.cleanup,
      () => rmSync(cwd, { recursive: true, force: true }),
    ]);
  }
}

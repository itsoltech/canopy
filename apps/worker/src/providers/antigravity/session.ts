import { sessionSelect, type AcpClient, type SessionResult } from "@canopy/acp";
import { PermissionMode } from "@canopy/contracts";
import type { AcpSettings } from "../acp/thread-types.ts";

export function checkAntigravityMode(mode: PermissionMode): void {
  if (
    mode !== PermissionMode.ASK &&
    mode !== PermissionMode.ACCEPT_EDITS &&
    mode !== PermissionMode.READ_ONLY &&
    mode !== PermissionMode.FULL_ACCESS
  )
    throw new Error("Antigravity cannot enforce the selected permission mode.");
}

async function select(client: AcpClient, session: SessionResult, category: string, value: string): Promise<void> {
  if (!value) return;
  const option = sessionSelect(session, category);

  if (!option?.options.some((row) => row.value === value))
    throw new Error(`Antigravity does not offer the selected ${category.replace("_", " ")} in this session.`);

  if (option.currentValue === value) return;
  const result = await client.setConfigOption(session.sessionId, option.id, value);

  if (sessionSelect(result, category)?.currentValue !== value)
    throw new Error(`Antigravity did not apply the requested ${category.replace("_", " ")}.`);

  session.configOptions = result.configOptions;
}

/** Mode "auto" can run commands outside the sandbox. Accept edits uses reviewed native edits and worker path checks. */
export async function configureAntigravitySession(
  client: AcpClient,
  session: SessionResult,
  settings: AcpSettings,
): Promise<void> {
  // Changing models can replace the list of thinking levels. Each response supplies the new selectors.
  if (settings.model && !sessionSelect(session, "model") && session.models) {
    if (!session.models.availableModels.some((model) => model.modelId === settings.model))
      throw new Error("Antigravity does not offer the selected model in this session.");

    if (session.models.currentModelId !== settings.model) {
      await client.setModel(session.sessionId, settings.model);
      session.models.currentModelId = settings.model;
    }
  } else await select(client, session, "model", settings.model);
  await select(client, session, "thought_level", settings.effort);

  if (!sessionSelect(session, "mode") && session.modes?.availableModes.some((mode) => mode.id === "default")) {
    if (session.modes.currentModeId !== "default") await client.setMode(session.sessionId, "default");
  } else await select(client, session, "mode", "default");
}

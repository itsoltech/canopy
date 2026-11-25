import { sessionSelect } from "@canopy/acp";
import type { ModelInit } from "../models.ts";
import type { AntigravityInstance } from "./launch.ts";
import { withAntigravitySession } from "./probe.ts";

/** Query the same authenticated ACP session configuration used to start a turn,
 * without sending a prompt. agy returns the thinking levels for the selected
 * model only. Selection writes to the probe's disposable CLI settings. */
export function listAntigravityModels(instance: AntigravityInstance): Promise<{ models: ModelInit[] }> {
  return withAntigravitySession(instance, async (client, session) => {
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
  });
}

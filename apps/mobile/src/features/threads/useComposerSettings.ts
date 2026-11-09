import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { composerChoices, type ComposerPick } from "@canopy/domain/composer-choices";
import { modelSections, useModelCatalog } from "../models/catalog";

type Picker = "model" | "effort" | "permission";

/** Explicit draft picks take precedence over the last user turn; sends store them on that turn. */
export function useComposerSettings(thread: ui.Thread | undefined, worker: ui.Worker | undefined) {
  const [picker, setPicker] = useState<Picker | null>(null);
  const [picks, setPicks] = useState<Record<string, ComposerPick>>({});
  const catalog = useModelCatalog(thread?.workerId);

  const section = thread
    ? modelSections(worker, catalog, { provider: thread.provider, profileId: thread.providerProfileId })[0]
    : undefined;

  const selected = composerChoices(thread, section?.choices ?? [], thread ? picks[thread.id] : undefined);

  function update(patch: ComposerPick) {
    if (!thread) return;
    setPicks((previous) => ({ ...previous, [thread.id]: { ...previous[thread.id], ...patch } }));
  }

  return {
    picker,
    setPicker,
    section,
    current: selected.option,
    effort: selected.effort,
    permissionMode: selected.permissionMode,
    override: {
      model: selected.option?.model,
      effort: selected.effort,
      permissionMode: selected.permissionMode,
    },
    update,
  };
}

import type { ImportLibraryItem, ui } from "@canopy/contracts";
import { InvalidError } from "../core/core-context.ts";
import { choosable } from "./library.ts";
import type { NewLibraryItem } from "./library-store.ts";

/**
 * The settings and library items of StartImport (docs/import.md, "Ustawienia i biblioteka"): only keys of the scan
 * that can be imported now, with an action they allow, and one permission mode at most.
 */
export function planLibrary(
  scanned: readonly ImportLibraryItem[],
  candidates: readonly ui.ImportLibraryCandidate[],
  choices: readonly ui.ImportLibraryChoice[],
): NewLibraryItem[] {
  const allowed = choosable(candidates);
  const items = new Map(scanned.map((i) => [i.sourceKey, i]));
  const seen = new Set<string>();

  const planned = choices.map((choice) => {
    const candidate = allowed.get(choice.key);
    const item = items.get(choice.key);

    if (!candidate || !item || seen.has(choice.key))
      throw new InvalidError("Some settings changed since the scan. Scan again.");
    seen.add(choice.key);
    const conflict = candidate.status === "conflict";
    const action = conflict ? choice.action : "import";

    if (conflict && !candidate.actions.includes(action))
      throw new InvalidError(`Choose Replace or Keep both for ${candidate.name}.`);

    return {
      agentCli: item.agentCli,
      rootId: item.rootId,
      kind: item.kind,
      name: item.name,
      digest: item.digest,
      sourceKey: item.sourceKey,
      value: item.value,
      label: candidate.name,
      action,
    };
  });

  if (planned.filter((p) => p.name === "permissions").length > 1)
    throw new InvalidError("Choose one permission mode for new threads.");

  return planned;
}

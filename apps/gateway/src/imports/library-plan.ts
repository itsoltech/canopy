import type { ImportLibraryItem, ui } from "@canopy/contracts";
import { InvalidError } from "../core/core-context.ts";
import { choosable } from "./library.ts";
import type { NewLibraryItem } from "./library-store.ts";
import { unsafeMarketplaceSource } from "./library-kinds.ts";

/**
 * The settings and library items of StartImport (docs/import.md, "Ustawienia i biblioteka"): only keys of the scan
 * that can be imported now, with an action they allow, and one permission mode at most.
 */
/** Kinds that become library skills. */
const SKILLS: ReadonlySet<string> = new Set(["skill", "command"]);

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

    if (item.kind === "marketplace" && unsafeMarketplaceSource(item.source))
      throw new InvalidError("The marketplace URL cannot be imported. Add it in Agent environment.");
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
      // A skill keeps the CLIs it was found in (its harnesses); a marketplace its source.
      value: SKILLS.has(item.kind)
        ? candidate.agentClis.join(",")
        : item.kind === "marketplace"
          ? item.source
          : item.value,
      label: candidate.name,
      action,
    };
  });

  if (planned.filter((p) => p.name === "permissions").length > 1)
    throw new InvalidError("Choose one permission mode for new threads.");
  const skills = planned.flatMap((p) => (SKILLS.has(p.kind) ? [p.name] : []));
  const twice = skills.find((name, index) => skills.indexOf(name) !== index);

  if (twice) throw new InvalidError(`Choose one version of ${twice}.`);

  return planned;
}

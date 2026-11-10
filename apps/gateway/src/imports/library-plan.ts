import { ui, type ImportLibraryItem } from "@canopy/contracts";
import { InvalidError } from "../core/core-context.ts";
import { choosable } from "./library.ts";
import type { NewLibraryItem } from "./library-store.ts";
import { unsafeConnectorUrl, unsafeMarketplaceSource } from "./library-kinds.ts";
import { toJson } from "@bufbuild/protobuf";

/**
 * The settings and library items of StartImport (docs/import.md, "Ustawienia i biblioteka"): only keys of the scan
 * that can be imported now, with an action they allow, and one permission mode at most.
 */
/**
 * What a row keeps about its item (never a secret): a skill its CLIs (harnesses), a marketplace its source, a
 * connector its endpoint, transport, header slots and the secrets the owner chose to bring.
 */
function valueOf(item: ImportLibraryItem, candidate: ui.ImportLibraryCandidate, secrets: readonly string[]): string {
  if (SKILLS.has(item.kind)) return candidate.agentClis.join(",");

  if (item.kind === "marketplace") return item.source;

  if (item.kind === "connector")
    return JSON.stringify({
      url: item.detail,
      transport: item.transport,
      secrets,
      slots: item.slots.map((s) => ({ name: s.name, kind: s.kind, variable: s.variable })),
    });

  return item.value;
}

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

    if (item.kind === "connector" && unsafeConnectorUrl(item.detail))
      throw new InvalidError("The server URL cannot be imported. Add it in Connectors.");
    const conflict = candidate.status === "conflict";
    const action = conflict ? choice.action : "import";

    if (conflict && !candidate.actions.includes(action))
      throw new InvalidError(`Choose Replace or Keep both for ${candidate.name}.`);
    const literal = new Set(candidate.slots.flatMap((slot) => (slot.kind === "literal" ? [slot.name] : [])));

    // A secret is read only for a header with its value in the file, and only one the owner chose.
    if (choice.secrets.some((name) => !literal.has(name)) || new Set(choice.secrets).size !== choice.secrets.length)
      throw new InvalidError(`Choose only headers of ${candidate.name} that have a value in the CLI file.`);

    if (choice.skillSelector && !SKILLS.has(item.kind))
      throw new InvalidError("Choose installation computers only for skills.");

    return {
      agentCli: item.agentCli,
      rootId: item.rootId,
      kind: item.kind,
      name: item.name,
      digest: item.digest,
      sourceKey: item.sourceKey,
      value: valueOf(item, candidate, choice.secrets),
      label: candidate.name,
      action,
      target:
        choice.skillSelector && action !== "replace"
          ? { selector: toJson(ui.EnvironmentSelectorSchema, choice.skillSelector) }
          : {},
    };
  });

  if (planned.filter((p) => p.name === "permissions").length > 1)
    throw new InvalidError("Choose one permission mode for new threads.");
  const skills = planned.flatMap((p) => (SKILLS.has(p.kind) ? [p.name] : []));
  const twice = skills.find((name, index) => skills.indexOf(name) !== index);

  if (twice) throw new InvalidError(`Choose one version of ${twice}.`);

  return planned;
}

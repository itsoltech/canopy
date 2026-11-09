import type { ui } from "@canopy/contracts";
import { listImportLibrary } from "./api.ts";
import { suggestedImportKeys } from "@canopy/domain/import-look";

/** Kinds that become library skills (a skill name is one skill). */
const SKILLS: ReadonlySet<string> = new Set(["skill", "command"]);

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "Something went wrong. Try again.");

/**
 * Settings and library of a scan (docs/import.md, "Ustawienia i biblioteka"): what each item would change, and the
 * owner's choice. New items the gateway suggests start chosen; a conflict needs Replace or Keep both.
 */
export class ImportLibraryState {
  items = $state.raw<readonly ui.ImportLibraryCandidate[]>([]);
  loading = $state(false);
  error = $state("");
  /** key → action (import | replace | keep_both). */
  chosen = $state(new Map<string, string>());
  /** key → header names whose value the owner chose to bring from the CLI file (none by default). */
  secrets = $state(new Map<string, ReadonlySet<string>>());

  async load(scanId: string): Promise<void> {
    this.loading = true;
    this.error = "";

    try {
      this.items = (await listImportLibrary(scanId)).items;
      this.chosen = new Map(suggestedImportKeys(this.items).map((key) => [key, "import"]));
      this.secrets = new Map();
    } catch (error) {
      this.items = [];
      this.chosen = new Map();
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
  }

  clear(): void {
    this.items = [];
    this.chosen = new Map();
    this.error = "";
  }

  /** Items that can be imported now: new ones and conflicts. */
  get importable(): readonly ui.ImportLibraryCandidate[] {
    return this.items.filter((i) => i.status === "new" || i.status === "conflict");
  }

  /** Items that are in Canopy already, or that stay out (with the reason). */
  get others(): readonly ui.ImportLibraryCandidate[] {
    return this.items.filter((i) => i.status !== "new" && i.status !== "conflict");
  }

  isChosen(key: string): boolean {
    return this.chosen.has(key);
  }

  toggle(item: ui.ImportLibraryCandidate, on: boolean): void {
    const next = new Map(this.chosen);

    if (on) next.set(item.key, item.status === "conflict" ? (item.actions[0] ?? "replace") : "import");
    else next.delete(item.key);

    // One permission mode for new threads, one version of a skill name: choosing one leaves the others.
    if (on && (item.name === "Permissions of new threads" || SKILLS.has(item.kind)))
      for (const other of this.items)
        if (other.key !== item.key && other.name === item.name && (other.kind === item.kind || SKILLS.has(other.kind)))
          next.delete(other.key);
    this.chosen = next;
  }

  setAction(key: string, action: string): void {
    const next = new Map(this.chosen);
    next.set(key, action);
    this.chosen = next;
  }

  actionOf(key: string): string {
    return this.chosen.get(key) ?? "";
  }

  choices(): { key: string; action: string; secrets: string[] }[] {
    return [...this.chosen].map(([key, action]) => ({ key, action, secrets: [...(this.secrets.get(key) ?? [])] }));
  }

  hasSecret(key: string, name: string): boolean {
    return this.secrets.get(key)?.has(name) ?? false;
  }

  toggleSecret(key: string, name: string, on: boolean): void {
    const next = new Map(this.secrets);
    const names = new Set(next.get(key));

    if (on) names.add(name);
    else names.delete(name);
    next.set(key, names);
    this.secrets = next;
  }

  get count(): number {
    return this.chosen.size;
  }
}

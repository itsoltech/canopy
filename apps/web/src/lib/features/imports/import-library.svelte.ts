import type { ui } from "@canopy/contracts";
import { listImportLibrary } from "./api.ts";

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

  async load(scanId: string): Promise<void> {
    this.loading = true;
    this.error = "";

    try {
      this.items = (await listImportLibrary(scanId)).items;
      this.chosen = new Map(this.items.filter((i) => i.suggested).map((i) => [i.key, "import"]));
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

    if (on) next.set(item.key, item.status === "conflict" ? "keep_both" : "import");
    else next.delete(item.key);

    // One permission mode for new threads: choosing one leaves the other.
    if (on && item.name === "Permissions of new threads")
      for (const other of this.items) if (other.key !== item.key && other.name === item.name) next.delete(other.key);
    this.chosen = next;
  }

  setAction(key: string, action: string): void {
    const next = new Map(this.chosen);
    next.set(key, action);
    this.chosen = next;
  }

  actionOf(key: string): string {
    return this.chosen.get(key) ?? "keep_both";
  }

  choices(): { key: string; action: string }[] {
    return [...this.chosen].map(([key, action]) => ({ key, action }));
  }

  get count(): number {
    return this.chosen.size;
  }
}

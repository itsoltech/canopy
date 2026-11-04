import { Schema } from "effect";
import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { bindingIdentity, bindingProblem, normalizeBinding } from "./binding-keys.ts";
import { bindingCatalogue, contextsOverlap, type BindingDefinition } from "./binding-catalogue.ts";

const key = "canopy:keybindings:v1";
const Stored = Schema.Record(Schema.String, Schema.Array(Schema.String));

export class Keybindings {
  overrides = $state<Record<string, string[]>>({});
  recording = $state(false);
  connect(): () => void {
    const read = () => {
      try {
        const parsed = Schema.decodeUnknownSync(Stored)(JSON.parse(localStorage.getItem(key) ?? "{}"));
        const clean: Record<string, string[]> = {};

        for (const [id, bindings] of Object.entries(parsed)) {
          if (id.length > 250 || !/^[\w:/.-]+$/.test(id) || bindings.length > 5) continue;
          const values = bindings.map(normalizeBinding);

          if (
            values.every((v): v is string => Boolean(v)) &&
            values.every((v) => !bindingProblem(v, id.startsWith("composer:")))
          )
            clean[id] = values;
        }

        this.overrides = clean;
      } catch {
        this.overrides = {};
      }
    };

    read();
    window.addEventListener("storage", read);

    return () => window.removeEventListener("storage", read);
  }
  get(id: string, fallback: readonly string[] = []): readonly string[] {
    return this.overrides[id] ?? bindingCatalogue.find((d) => d.id === id)?.defaults ?? fallback;
  }
  matches(event: KeyboardEvent, id: string, fallback: readonly string[] = []): boolean {
    return (
      !this.recording &&
      !event.isComposing &&
      !event.repeat &&
      this.get(id, fallback).some((binding) => matchesHotkey(event, binding === "Space" ? " " : binding))
    );
  }
  conflicts(id: string, binding: string, definitions: readonly BindingDefinition[]): BindingDefinition[] {
    const context = definitions.find((d) => d.id === id)?.context ?? "global";

    return definitions.filter(
      (d) =>
        d.id !== id &&
        contextsOverlap(context, d.context) &&
        this.get(d.id, d.defaults).some((v) => bindingIdentity(v) === bindingIdentity(binding)),
    );
  }
  save(id: string, values: readonly string[], definitions: readonly BindingDefinition[]): string | undefined {
    if (values.length > 5) return "A command can have at most 5 shortcuts. Remove one first.";
    const normalized: string[] = [];

    for (const value of values) {
      const problem = bindingProblem(value, id.startsWith("composer:"));

      if (problem) return problem;
      const parsed = normalizeBinding(value)!;
      const conflicts = this.conflicts(id, parsed, definitions);

      if (conflicts.length)
        return `Already used by ${conflicts.map((c) => c.title).join(", ")}. Remove that binding first.`;

      if (normalized.some((v) => bindingIdentity(v) === bindingIdentity(parsed)))
        return "This command already has that shortcut. Choose another combination.";
      normalized.push(parsed);
    }

    this.overrides = { ...this.overrides, [id]: normalized };
    this.persist();

    return undefined;
  }
  reset(id?: string): void {
    if (!id) this.overrides = {};
    else {
      const next = { ...this.overrides };
      delete next[id];
      this.overrides = next;
    }

    this.persist();
  }
  private persist(): void {
    try {
      localStorage.setItem(key, JSON.stringify(this.overrides));
    } catch {
      toast("Shortcuts could not be saved. Allow browser storage to keep them after closing this tab.", {
        tone: "error",
      });
    }
  }
}

export const keybindings = new Keybindings();

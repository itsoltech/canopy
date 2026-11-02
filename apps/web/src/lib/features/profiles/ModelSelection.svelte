<script lang="ts">
  import type { ModelInfo, ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import type { ClassValue } from "svelte/elements";
  import { initialShown, matchesSearch, newSince } from "./profiles.ts";

  /**
   * Which of a profile's catalog models pickers show. The whole catalog is listed (also what the provider hides);
   * search narrows the list and "All" / "None" act on what the search shows. Models from later listings follow
   * the "new models" choice. Saving sends the shown models and the catalog as it is now; the default list is the
   * catalog as the provider sends it (no selection).
   */
  let {
    models,
    selection,
    providerName,
    hiddenByProvider,
    onsave,
    onreset,
    class: className,
  }: {
    models: readonly ModelInfo[];
    selection: ui.ModelSelection | undefined;
    providerName: string;
    /** The catalog itself hides these (e.g. Codex `hidden`); listed so they can be shown. */
    hiddenByProvider: ReadonlySet<string>;
    onsave: (shown: string[], showNew: boolean) => Promise<void>;
    onreset: () => Promise<void>;
    class?: ClassValue;
  } = $props();

  let shown = $state(new Set<string>());
  let showNew = $state(true);
  let query = $state("");
  let busy = $state<"save" | "reset">();
  let failure = $state<string>();
  // Back to the saved state whenever the saved selection or the catalog change (after a save or a refresh).
  $effect.pre(() => {
    shown = initialShown(models, selection);
    showNew = selection?.showNew ?? true;
  });

  const fresh = $derived(newSince(models, selection));
  const visible = $derived(models.filter((m) => matchesSearch(m, query)));
  const count = $derived(models.filter((m) => shown.has(m.id)).length);
  const allVisibleShown = $derived(visible.length > 0 && visible.every((m) => shown.has(m.id)));

  function set(ids: Iterable<string>, on: boolean) {
    const next = new Set(shown);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    shown = next;
  }

  async function run(kind: "save" | "reset", action: () => Promise<void>) {
    busy = kind;
    failure = undefined;
    try {
      await action();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = undefined;
    }
  }
</script>

<div class={["grid gap-4", className]}>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <SearchField label="Search models" name="model-search" bind:value={query} placeholder="Search {models.length} models" class="min-w-0 flex-1 basis-56" />
    <div class="flex items-center gap-1">
      <Button size="sm" variant="ghost" disabled={allVisibleShown} onclick={() => set(visible.map((m) => m.id), true)}>{query ? "All found" : "All"}</Button>
      <Button size="sm" variant="ghost" disabled={visible.every((m) => !shown.has(m.id))} onclick={() => set(visible.map((m) => m.id), false)}>{query ? "None found" : "None"}</Button>
    </div>
  </div>

  <p class="text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400" aria-live="polite">{count} of {models.length} shown in pickers</p>

  {#if visible.length > 0}
    <ul role="list" class="divide-y divide-zinc-950/5 rounded-xl ring-1 ring-zinc-950/10 dark:divide-white/8 dark:ring-white/10">
      {#each visible as model (model.id)}
        <li class="px-3 py-2.5">
          <Checkbox
            name="model-{model.id}"
            label={model.displayName || model.id}
            description={[model.displayName && model.displayName !== model.id ? model.id : "", model.description].filter(Boolean).join(" · ") || undefined}
            bind:checked={() => shown.has(model.id), (on) => set([model.id], on)}
          >
            {#snippet aside()}
              {#if model.isDefault}<Badge tone="sky">Default</Badge>{/if}
              {#if fresh.has(model.id)}<Badge tone="violet">New</Badge>{/if}
              {#if hiddenByProvider.has(model.id)}<Badge>Hidden by {providerName}</Badge>{/if}
            {/snippet}
          </Checkbox>
        </li>
      {/each}
    </ul>
  {:else if models.length === 0}
    <EmptyState icon="queue-list" title="No models listed yet" description="Refresh the list once the worker is online." />
  {:else}
    <EmptyState icon="magnifying-glass" title="No model matches “{query}”" />
  {/if}

  <Checkbox
    name="show-new"
    label="Show new models"
    description="Models that appear in later listings of this profile show up in pickers until you choose otherwise."
    bind:checked={showNew}
  />

  {#if count === 0 && !showNew}
    <Alert tone="warning">Choose at least one model. To stop using this profile, turn it off instead.</Alert>
  {/if}
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}

  <DialogActions>
    <Button disabled={!selection || Boolean(busy)} loading={busy === "reset"} onclick={() => run("reset", onreset)}>Use the default list</Button>
    <Button
      variant="primary"
      disabled={(count === 0 && !showNew) || Boolean(busy)}
      loading={busy === "save"}
      onclick={() => run("save", () => onsave(models.filter((m) => shown.has(m.id)).map((m) => m.id), showNew))}
    >
      Save
    </Button>
  </DialogActions>
</div>

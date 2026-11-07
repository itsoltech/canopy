<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import type { ImportLibraryState } from "./import-library.svelte.ts";
  import { providerKey } from "./labels.ts";

  /** One setting or library item of the scan: what it changes in Canopy, or why it stays out. */
  let { item, library }: { item: ui.ImportLibraryCandidate; library: ImportLibraryState } = $props();

  const statuses = new Map([
    ["same", "Same in Canopy"],
    ["imported", "Imported"],
    ["unavailable", "Not imported"],
  ]);

  const actions = [
    { value: "keep_both", label: "Keep both" },
    { value: "replace", label: "Replace" },
  ];

  const choosable = $derived(item.status === "new" || item.status === "conflict");
  const chosen = $derived(library.isChosen(item.key));

  const change = $derived(
    item.current && item.proposed && item.current !== item.proposed
      ? `${item.current} → ${item.proposed}`
      : item.proposed,
  );

  const id = $props.id();

  let action = $state("keep_both");

  $effect(() => {
    if (chosen && item.status === "conflict") library.setAction(item.key, action);
  });
</script>

<li class="flex items-start gap-3 px-4 py-2.5">
  {#if choosable}
    <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
      <ChoiceControl
        id={`${id}-choose`}
        name="importSetting"
        aria-label={`Import ${item.name}`}
        checked={chosen}
        onchange={(event) => library.toggle(item, event.currentTarget.checked)}
      />
    </div>
  {:else}
    <!-- Keeps the text in line with the rows that have a checkbox. -->
    <div class="flex h-lh items-center text-base/6 sm:text-sm/6" aria-hidden="true">
      <span class="size-5 sm:size-4"></span>
    </div>
  {/if}
  <div class="min-w-0 flex-1 text-base/6 sm:text-sm/6">
    <label for={`${id}-choose`} class="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={providerKey(item.agentCli)} size="sm" class="shrink-0" />
      <TruncatedText text={item.name} class="min-w-0 text-zinc-950 dark:text-white" />
      {#if statuses.get(item.status)}<Badge compact>{statuses.get(item.status)}</Badge>{/if}
      {#if item.status === "conflict"}<Badge compact tone="amber">Name taken</Badge>{/if}
    </label>
    {#if change && item.status !== "unavailable"}
      <p class="text-sm text-zinc-600 sm:text-xs dark:text-zinc-300"><TruncatedText text={change} /></p>
    {/if}
    {#if item.status === "unavailable" || item.reason}
      <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">{item.reason}</p>
    {/if}
    {#each item.warnings as warning (warning)}
      <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">{warning}</p>
    {/each}
    {#if item.status === "conflict" && chosen}
      <div class="mt-1.5">
        <SegmentedChoice label={`What to do with ${item.name}`} options={actions} bind:value={action} />
      </div>
    {/if}
  </div>
</li>

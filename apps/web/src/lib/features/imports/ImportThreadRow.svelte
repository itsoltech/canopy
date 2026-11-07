<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { formatRelative } from "#lib/shared/format.ts";
  import { counted, ORIGINS, providerKey, size } from "./labels.ts";

  /** One CLI thread of the scan: what it is, how big, and what it becomes after import. */
  let {
    candidate,
    selected,
    onselect,
  }: { candidate: ui.ImportCandidate; selected: boolean; onselect: (selected: boolean) => void } = $props();

  const statuses = new Map([
    ["imported", "Imported"],
    ["has_new_turns", "Has new turns"],
    ["in_canopy", "Already in Canopy"],
    ["unsupported", "Not supported yet"],
  ]);

  const title = $derived(candidate.title || candidate.preview || "Untitled thread");
  const id = $props.id();
</script>

<li class="flex items-start gap-3 px-4 py-2.5">
  <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
    <ChoiceControl
      id={`${id}-select`}
      name="importThread"
      aria-label={`Import ${title}`}
      checked={selected}
      disabled={candidate.status !== "new"}
      onchange={(event) => onselect(event.currentTarget.checked)}
    />
  </div>
  <label for={`${id}-select`} class="min-w-0 flex-1 text-base/6 sm:text-sm/6">
    <span class="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={providerKey(candidate.agentCli)} size="sm" class="shrink-0" />
      <TruncatedText
        text={title}
        class={[
          "min-w-0",
          candidate.title ? "text-zinc-950 dark:text-white" : "text-zinc-600 italic dark:text-zinc-300",
        ]}
      />
    </span>
    <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
      <span>{formatRelative(candidate.updatedAt)}</span>
      <span aria-hidden="true">·</span>
      <span>{size(candidate.bytes)}</span>
      {#if candidate.turns > 0}<span aria-hidden="true">·</span><span>{counted(candidate.turns, "turn")}</span>{/if}
      <span aria-hidden="true">·</span>
      <span>{ORIGINS.get(candidate.origin) ?? candidate.origin}</span>
      {#if statuses.get(candidate.status)}<Badge compact tone="sky">{statuses.get(candidate.status)}</Badge>{/if}
      {#if candidate.continueMode === "history"}
        <span {@attach tooltip(candidate.reason)}><Badge compact tone="amber">History only</Badge></span>
      {/if}
      {#if candidate.flaggedSecrets > 0}
        <span {@attach tooltip("Canopy masks values that look like secrets.")}>
          <Badge compact>Secrets masked</Badge>
        </span>
      {/if}
    </span>
  </label>
</li>

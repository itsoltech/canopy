<script lang="ts">
  import type { bots } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import DetailsSection from "./DetailsSection.svelte";

  let { counts }: { counts: NonNullable<bots.Bot["delegatedThreads"]> | null } = $props();
</script>

<DetailsSection title="Delegated threads">
  <div role="status" class="grid gap-2">
    <dl
      class="grid grid-cols-2 divide-x divide-zinc-950/8 rounded-xl border border-zinc-950/8 bg-white dark:divide-white/8 dark:border-white/8 dark:bg-white/4"
    >
      {#each [{ label: "Working", count: counts?.working }, { label: "Finished", count: counts?.finished }] as { label, count } (label)}
        <div class="flex min-w-0 flex-col-reverse justify-end gap-0.5 px-3 py-2.5">
          <dt class="text-sm/5 text-zinc-500 dark:text-zinc-400">{label}</dt>
          <dd class="text-2xl/7 font-semibold wrap-anywhere text-zinc-950 tabular-nums dark:text-white">
            {count ?? "—"}
          </dd>
        </div>
      {/each}
    </dl>
    {#if !counts}
      <p class="flex items-center gap-1.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
        <Icon name="question-mark-circle" size="xs" />Thread status unavailable
      </p>
    {/if}
  </div>
</DetailsSection>

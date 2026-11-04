<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import type { BotProviderInstance } from "./draft.ts";

  let {
    instances,
    class: className,
  }: {
    instances: readonly BotProviderInstance[];
    class?: ClassValue;
  } = $props();

  const unavailable = $derived(instances.filter((instance) => instance.disabledReason));
  const reasons = $derived([...new Set(unavailable.map((instance) => instance.disabledReason))]);
</script>

{#if unavailable.length > 0}
  <Disclosure class={className}>
    {#snippet summary()}
      <span class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Unavailable instances ({unavailable.length})
      </span>
    {/snippet}
    <div class="grid min-w-0 gap-2 pt-2 text-base/6 sm:text-sm/6">
      {#each reasons as reason (reason)}
        <p class="text-pretty text-zinc-500 dark:text-zinc-400">{reason}</p>
      {/each}
      <ul class="grid min-w-0 gap-2">
        {#each unavailable as instance (instance.id)}
          <li class="flex min-w-0 items-start gap-2">
            <span class="flex h-lh shrink-0 items-center"><ProviderIcon provider={instance.provider} /></span>
            <a
              href={instance.settingsHref ?? "/settings/providers"}
              class="min-w-0 rounded-md wrap-anywhere underline focus-ring"
            >
              Configure {instance.name}
            </a>
          </li>
        {/each}
      </ul>
    </div>
  </Disclosure>
{/if}

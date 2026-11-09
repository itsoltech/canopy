<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import RequestCountdown from "./RequestCountdown.svelte";

  let {
    expiresAt,
    pending,
    children,
    class: className,
  }: { expiresAt?: Date; pending: boolean; children: Snippet; class?: ClassValue } = $props();
</script>

<!-- Respond to the card's width, including inside a sidebar or a narrow composer. -->
<div class={["@container min-w-0 flex-1", className]}>
  <div class="grid grid-cols-[minmax(0,1fr)] items-start gap-x-3 gap-y-1 @min-[24rem]:grid-cols-[minmax(0,1fr)_auto]">
    <div class="min-w-0">{@render children()}</div>
    {#if expiresAt}
      <div class="flex h-lh items-center justify-self-end">
        <RequestCountdown {expiresAt} {pending} />
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    expiresAt,
    pending = true,
    class: className,
  }: { expiresAt?: Date | undefined; pending?: boolean; class?: ClassValue } = $props();

  let now = $state(Date.now());
  const seconds = $derived(Math.max(0, Math.ceil(((expiresAt?.getTime() ?? now) - now) / 1000)));
  const digits = new Intl.NumberFormat("en", { minimumIntegerDigits: 2, useGrouping: false });
  const minutes = new Intl.NumberFormat("en", { useGrouping: false });

  $effect(() => {
    if (!expiresAt || !pending) return;
    // The app has no server clock offset. Recompute from the client clock, including after tab suspension.
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);

    return () => clearInterval(timer);
  });
</script>

<!-- Keep the line and its width when resolved; seconds never announce over a screen reader's current task. -->
<span
  class={[
    "inline-block min-h-5 min-w-[8.5rem] shrink-0 text-right text-sm/5 whitespace-nowrap tabular-nums sm:text-xs/5",
    pending && expiresAt && seconds <= 25 ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400",
    className,
  ]}
>
  {#if expiresAt && pending}
    {#if seconds > 0}Expires in {minutes.format(Math.floor(seconds / 60))}:{digits.format(
        seconds % 60,
      )}{:else}Expiring…{/if}
  {/if}
</span>

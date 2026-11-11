<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    userId,
    login,
    compact = false,
    class: className,
  }: { userId: string; login: string; compact?: boolean; class?: ClassValue } = $props();

  let failed = $state(false);
</script>

<span
  class={[
    "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/10 font-medium text-zinc-500 ring-1 ring-zinc-950/5 ring-inset dark:text-zinc-400 dark:ring-white/10",
    compact ? "size-5 text-xs" : "size-8 text-sm",
    className,
  ]}
  aria-hidden="true"
>
  {login.slice(0, 2).toUpperCase()}
  {#if !failed && /^[1-9][0-9]*$/.test(userId)}
    <img
      src={`https://avatars.githubusercontent.com/u/${userId}?s=64`}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      class="absolute inset-0 size-full object-cover"
      onerror={() => (failed = true)}
    />
  {/if}
</span>

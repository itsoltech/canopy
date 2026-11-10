<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { userId, login, class: className }: { userId: string; login: string; class?: ClassValue } = $props();
  let failed = $state(false);
</script>

<span
  class={[
    "relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/10 text-sm font-medium text-zinc-500 dark:text-zinc-400",
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

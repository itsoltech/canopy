<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * A file as a chip: icon, name and a second line (size and type, or why it failed). With `href` the whole chip
   * downloads the file; `trailing` adds something at the end (a download arrow).
   */
  let {
    name,
    detail,
    failed = false,
    href,
    trailing,
    class: className,
  }: {
    name: string;
    detail: string;
    failed?: boolean;
    href?: string | undefined;
    trailing?: Snippet | undefined;
    class?: ClassValue;
  } = $props();
</script>

{#snippet body()}
  <Icon
    name={failed ? "exclamation-circle" : "document-text"}
    class={["shrink-0", failed ? "fill-rose-600 dark:fill-rose-400" : "fill-zinc-400 dark:fill-zinc-500"]}
  />
  <div class="min-w-0">
    <p class="truncate text-sm/5 font-medium text-zinc-950 sm:text-xs/5 dark:text-white">{name}</p>
    <p
      class={[
        "truncate text-sm/5 tabular-nums sm:text-xs/5",
        failed ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
      ]}
    >
      {detail}
    </p>
  </div>
  {@render trailing?.()}
{/snippet}

{#if href}
  <a
    {href}
    download={name}
    class={["flex min-w-0 items-center gap-2.5 focus-ring hover:bg-zinc-950/2.5 dark:hover:bg-white/5", className]}
    >{@render body()}</a
  >
{:else}
  <div class={["flex min-w-0 items-center gap-2.5", className]}>{@render body()}</div>
{/if}

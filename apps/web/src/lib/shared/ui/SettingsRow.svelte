<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import Badge from "./Badge.svelte";

  /**
   * One row of a settings card: title, description, and a control on the right. With `href` the whole
   * row is a link with a chevron (lists of projects, workers). With `soon` the feature behind the setting
   * does not exist yet: the title gets a "Soon" badge and the control is disabled, so the stored value stays.
   * `flush`: no padding, for a row inside a section that pads its content already (an expanded worker).
   */
  let {
    title,
    description,
    href,
    class: className,
    leading,
    control,
    children,
    soon = false,
    flush = false,
  }: {
    title: string;
    description?: string | undefined;
    href?: string | undefined;
    class?: ClassValue;
    leading?: Snippet;
    control?: Snippet;
    children?: Snippet;
    soon?: boolean;
    flush?: boolean;
  } = $props();
</script>

{#snippet body()}
  {#if leading}<div class="flex h-lh shrink-0 items-center text-base/6 sm:text-sm/6">{@render leading()}</div>{/if}
  <div class="settings-row-copy min-w-0 flex-1">
    <div class="flex min-w-0 items-center gap-2">
      <p class="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
      {#if soon}<Badge compact>Soon</Badge>{/if}
    </div>
    {#if description}<p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
    {@render children?.()}
  </div>
  {#if control}<div class="settings-row-control flex shrink-0 items-center gap-2">
      <!-- A disabled fieldset disables every native control inside, whatever the kit component. -->
      <fieldset disabled={soon} class="contents">{@render control()}</fieldset>
    </div>{/if}
  {#if href}<Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-600" />{/if}
{/snippet}

{#if href}
  <a
    {href}
    class={[
      "settings-row flex items-center gap-3 px-4 py-3.5 focus-ring hover:bg-zinc-950/2.5 focus-visible:-outline-offset-2 dark:hover:bg-white/2.5",
      className,
    ]}>{@render body()}</a
  >
{:else}
  <!-- A control stacks under the copy on phones; a row without one stays a row. -->
  <div
    class={[
      "settings-row flex gap-3",
      flush ? "settings-row-flush" : "px-4 py-3.5",
      control ? "flex-col items-start sm:flex-row sm:items-center" : "items-center",
      className,
    ]}
  >
    {@render body()}
  </div>
{/if}

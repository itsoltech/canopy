<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";

  let {
    commit = $bindable(""),
    tree = $bindable(false),
    options,
    count,
    viewed,
    more,
    busy,
    class: className,
  }: {
    commit?: string;
    tree?: boolean;
    options: { value: string; label: string }[];
    count: string;
    viewed: string;
    more?: (() => void) | undefined;
    busy: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div
  aria-label="Code toolbar"
  class={[
    "@container/code sticky top-14 z-30 flex h-12 min-w-0 items-center gap-1 border-b border-zinc-950/10 bg-surface dark:border-white/10",
    className,
  ]}
>
  <DropdownMenu label="Commit filter" placement="bottom-start" sheet>
    {#snippet trigger(props)}<Button {...props} size="sm" variant="ghost" title="Commit filter"
        ><span class="max-w-24 truncate"
          >{#if commit}{commit.slice(0, 7)}{:else}All<span class="hidden @min-[400px]/code:inline">{" commits"}</span
            >{/if}</span
        ><Icon name="chevron-down" size="sm" /></Button
      >{/snippet}
    {#each options as option (option.value)}<MenuCheckItem
        checked={commit === option.value}
        onselect={() => (commit = option.value)}>{option.label}</MenuCheckItem
      >{/each}
    {#if more}<MenuItem disabled={busy} onselect={more}>Load more commits</MenuItem>{/if}
  </DropdownMenu>
  <p
    class="min-w-0 flex-1 text-xs text-zinc-500 tabular-nums dark:text-zinc-400"
    title={`${count} files · Viewed applies to the whole pull request`}
  >
    {viewed} viewed
  </p>
  <div class="flex shrink-0 gap-0.5" role="group" aria-label="Diff display">
    <IconButton
      size="sm"
      icon={device.values.diffLayout === "split" ? "view-columns" : "square-2-stack"}
      label={device.values.diffLayout === "split"
        ? "Side by side · switch to stacked"
        : "Stacked · switch to side by side"}
      aria-pressed={device.values.diffLayout === "split"}
      onclick={() => device.set("diffLayout", device.values.diffLayout === "split" ? "stacked" : "split")}
    />
    <IconButton
      size="sm"
      icon="text-wrap"
      label="Wrap"
      aria-pressed={device.values.wrapDiffs === "on"}
      class={[device.values.wrapDiffs === "on" && "bg-zinc-500/10"]}
      onclick={() => device.set("wrapDiffs", device.values.wrapDiffs === "on" ? "off" : "on")}
    />
    <IconButton
      size="sm"
      icon="space"
      label="Hide whitespace"
      aria-pressed={device.values.hideWhitespace === "on"}
      class={[device.values.hideWhitespace === "on" && "bg-zinc-500/10"]}
      onclick={() => device.set("hideWhitespace", device.values.hideWhitespace === "on" ? "off" : "on")}
    />
    <IconButton
      size="sm"
      icon="file-tree"
      label="File tree"
      aria-pressed={tree}
      class={[tree && "bg-zinc-500/10"]}
      onclick={() => (tree = !tree)}
    />
  </div>
</div>

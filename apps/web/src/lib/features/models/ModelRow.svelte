<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import { providerName, type ModelOption } from "./catalog.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * One model in the picker's list: its name, a line under it (profile and/or the catalog's description),
   * its favorite shortcut, a star and a check on the current one. A custom model reads "Use “…” with …".
   * The star shows on the active row only (always on touch screens and when starred).
   */
  let {
    option,
    detail,
    providerMark = true,
    active,
    selected,
    starred,
    shortcut,
    onstar,
    class: className,
  }: {
    option: ModelOption;
    /** The line under the name ("" = none). */
    detail: string;
    /** Provider mark in front of the line (off under a profile heading). */
    providerMark?: boolean;
    active: boolean;
    selected: boolean;
    starred: boolean;
    /** Hotkey of a favorite (`Mod+1`). */
    shortcut?: string | undefined;
    onstar: () => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex items-center gap-2", className]}>
  {#if option.origin === "custom"}
    <Icon name="plus" class="fill-zinc-500 dark:fill-zinc-400" />
    <span class="min-w-0 flex-1 truncate">Use “{option.model}” <span class="text-zinc-500 dark:text-zinc-400">with {providerName(option.provider)} · {option.profileName}</span></span>
  {:else}
    <span class="grid min-w-0 flex-1">
      <span class="truncate font-medium" title={option.model || undefined}>{option.name}</span>
      {#if detail}
        <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
          {#if providerMark}<ProviderIcon provider={option.provider} class="size-3" />{/if}
          <span class="truncate" title={option.description || undefined}>{detail}</span>
        </span>
      {/if}
    </span>
    {#if shortcut}<Kbd hotkey={shortcut} />{/if}
    <IconButton
      icon="star"
      size="sm"
      tabindex={-1}
      label={starred ? `Remove ${option.name} (${option.profileName}) from favorites` : `Add ${option.name} (${option.profileName}) to favorites`}
      aria-pressed={starred}
      iconClass={starred ? "fill-amber-500" : ["fill-zinc-300 dark:fill-zinc-600", !active && "pointer-fine:invisible"]}
      onclick={(event) => {
        event.stopPropagation();
        onstar();
      }}
    />
    <Icon name="check" class={["fill-brand-600 dark:fill-brand-400", !selected && "invisible"]} />
  {/if}
</div>

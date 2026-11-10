<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { fontStack, localFontFamily, type FontKind } from "@canopy/ui/fonts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { fontMonospace, lazyFontPreview } from "./local-fonts.ts";

  let {
    value,
    label,
    selected,
    kind,
    class: className,
  }: {
    value: string;
    label: string;
    selected: boolean;
    kind: FontKind;
    class?: ClassValue;
  } = $props();

  let visible = $state(false);
  const family = $derived(localFontFamily(value));
  const monospace = $derived(visible && family ? fontMonospace(family) : false);
</script>

<div
  class={["flex min-w-0 items-center gap-2", className]}
  {@attach (node) => lazyFontPreview(node, () => (visible = true))}
>
  <span class="min-w-0 flex-1 truncate" title={label} style:font-family={visible ? fontStack(value, kind) : undefined}
    >{label}</span
  >
  {#if kind === "mono" && family && visible}
    <span class="shrink-0 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
      >{monospace ? "Monospace" : "Proportional"}</span
    >
  {/if}
  <Icon name="check" class={["shrink-0 text-brand-600 dark:text-brand-400", !selected && "invisible"]} />
</div>

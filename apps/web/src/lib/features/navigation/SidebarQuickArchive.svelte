<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  let {
    archived,
    label,
    disabled = false,
    loading = false,
    onclick,
    class: className,
  }: {
    archived: boolean;
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onclick: (event: MouseEvent) => void;
    class?: ClassValue;
  } = $props();
</script>

<span
  class={["sidebar-quick-archive sidebar-swap-action absolute flex size-3.5 items-center justify-center", className]}
>
  <IconButton
    icon={archived ? "arrow-uturn-left" : "archive-box"}
    {label}
    tooltipText={archived ? "Unarchive" : "Archive"}
    size="sm"
    iconClass="size-3.5"
    {disabled}
    {loading}
    {onclick}
  />
</span>

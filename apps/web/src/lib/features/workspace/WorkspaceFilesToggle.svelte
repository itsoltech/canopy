<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  let {
    pressed,
    disabled = false,
    onclick,
    class: className,
  }: { pressed?: boolean | undefined; disabled?: boolean; onclick?: () => void; class?: ClassValue } = $props();
</script>

<div class={["shrink-0", className]}>
  <div class="sm:hidden">
    <IconButton
      {disabled}
      size="sm"
      icon="folder"
      label="Files"
      class="aria-pressed:bg-zinc-950/5 dark:aria-pressed:bg-white/10"
      aria-pressed={pressed}
      {onclick}
    />
  </div>
  <div class="max-sm:hidden">
    <Button
      {disabled}
      variant="ghost"
      size="sm"
      icon="folder"
      class="aria-pressed:bg-zinc-950/5 dark:aria-pressed:bg-white/10"
      aria-pressed={pressed}
      {onclick}>Files</Button
    >
  </div>
</div>

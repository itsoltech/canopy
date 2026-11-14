<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import { formatRelative } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    row,
    selected,
    disabled,
    onselect,
    ontake,
    ondiscard,
    class: className = "",
  }: {
    row: ui.ComposerDraft;
    selected: boolean;
    disabled: boolean;
    onselect: () => void;
    ontake: (replace: boolean) => void;
    ondiscard: () => void;
    class?: string;
  } = $props();

  const preview = $derived(row.content?.text.trim() || (row.content?.quotes.length ? "Quoted text" : "Attachments"));
</script>

<div class={className}>
  <div class="flex min-w-0 items-center gap-1 rounded-lg hover:bg-zinc-950/5 dark:hover:bg-white/5">
    <button
      type="button"
      {disabled}
      aria-label={`Take over draft: ${preview}`}
      aria-expanded={selected}
      onclick={onselect}
      class="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left focus-ring disabled:opacity-50"
    >
      <span class="min-w-0 flex-1 truncate" title={preview}>{preview}</span>
      {#if row.content?.attachments.length}
        <span class="flex shrink-0 items-center gap-0.5" aria-label={`${row.content.attachments.length} attachments`}
          ><Icon name="paper-clip" size="sm" />{row.content.attachments.length}</span
        >
      {/if}
      <span class="max-w-24 shrink truncate text-zinc-500 dark:text-zinc-400" title={row.deviceName}
        >{row.deviceName}</span
      >
      <span class="shrink-0 whitespace-nowrap text-zinc-500 dark:text-zinc-400"
        >{formatRelative(timestampFromMs(Number(row.updatedAtMs)), clock.now)}</span
      >
    </button>
    <IconButton icon="x-mark" label="Discard draft" size="sm" {disabled} onclick={ondiscard} />
  </div>
  {#if selected}
    <div class="flex flex-wrap justify-end gap-1 px-2 pb-1">
      <Button size="sm" variant="ghost" {disabled} onclick={() => ontake(false)}>Append draft</Button>
      <Button size="sm" variant="ghost" {disabled} onclick={() => ontake(true)}>Replace local draft</Button>
    </div>
  {/if}
</div>

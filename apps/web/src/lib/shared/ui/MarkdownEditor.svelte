<script lang="ts">
  import Textarea from "./Textarea.svelte";
  import Button from "./Button.svelte";
  import Markdown from "./markdown/Markdown.svelte";

  let {
    value = $bindable(""),
    label,
    name,
    placeholder = "Write in Markdown…",
    disabled = false,
  }: { value?: string; label: string; name: string; placeholder?: string; disabled?: boolean } = $props();

  let preview = $state(false);
</script>

<div class="grid min-w-0 gap-2">
  <div class="flex items-center justify-between gap-2">
    <span class="text-sm font-medium">{label}</span>
    <Button size="sm" variant="ghost" aria-pressed={preview} onclick={() => (preview = !preview)}
      >{preview ? "Write" : "Preview"}</Button
    >
  </div>
  {#if preview}
    <div class="min-h-28 min-w-0 [&>div]:[overflow-wrap:anywhere]">
      {#if value}<Markdown text={value} />{:else}<p class="text-sm text-zinc-500">Nothing to preview</p>{/if}
    </div>
  {:else}
    <Textarea
      {name}
      aria-label={label}
      {placeholder}
      rows={4}
      resize={false}
      class="field-sizing-content max-h-80 min-h-28"
      bind:value
      {disabled}
    />
  {/if}
</div>

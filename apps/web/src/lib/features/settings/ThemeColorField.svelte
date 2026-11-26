<script lang="ts">
  import { normalizeColor } from "@canopy/ui/color";
  import { defaultThemeTokenHex } from "@canopy/ui/theme-builder";
  import Button from "#lib/shared/ui/Button.svelte";
  import CustomColorPicker from "#lib/shared/ui/CustomColorPicker.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";

  let {
    label,
    group,
    value,
    overridden,
    onchange,
  }: {
    label: string;
    group?: string | undefined;
    value: string;
    overridden: boolean;
    onchange: (value: string | undefined) => void;
  } = $props();

  const overrideStatusId = $props.id();
  let open = $state(false);
  let draft = $state("");
  const hex = $derived(defaultThemeTokenHex(value));
  const selected = $derived(normalizeColor(draft));
  const editLabel = $derived(group ? `Edit shade ${label}, ${group.toLowerCase()}` : `Edit ${label.toLowerCase()}`);

  function setOpen(next: boolean) {
    if (next) draft = hex;
    open = next;
  }

  function setColor(event: SubmitEvent) {
    event.preventDefault();

    if (selected && selected !== hex) {
      onchange(selected);
      open = false;
    }
  }

  function restoreDefault() {
    onchange(undefined);
    open = false;
  }
</script>

{#snippet swatch(color: string)}
  <span
    class="size-5 shrink-0 rounded-md border border-zinc-950/15 dark:border-white/20"
    style:background-color={color}
    aria-hidden="true"
  ></span>
{/snippet}

<Popover bind:open={() => open, setOpen} label={editLabel} class="w-[min(25rem,calc(100vw-1rem))]" sheet>
  {#snippet trigger(props)}
    <button
      type="button"
      class="grid min-h-(--settings-target) w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-start focus-ring hover:bg-hover aria-expanded:bg-hover"
      aria-label={`${editLabel}, ${hex}`}
      aria-describedby={overridden ? overrideStatusId : undefined}
      {...props}
    >
      {@render swatch(value)}
      <span class="text-base/5 wrap-break-word">{label}</span>
      <span class="font-mono text-xs/5 text-muted tabular-nums">{hex}</span>
    </button>
    {#if overridden}<span id={overrideStatusId} class="sr-only">Custom color</span>{/if}
  {/snippet}

  <form class="grid min-w-0 gap-2 p-3" onsubmit={setColor}>
    <div class="flex items-center gap-2 px-1">
      {@render swatch(selected ?? value)}
      <span class="min-w-0 text-base/5 font-semibold wrap-break-word">{group ? `${group} · ${label}` : label}</span>
    </div>
    <CustomColorPicker bind:value={draft} />
    <div class="flex flex-wrap items-center gap-2">
      {#if overridden}<Button variant="ghost" onclick={restoreDefault}>Restore default</Button>{/if}
      <Button type="submit" variant="primary" class="ms-auto" disabled={!selected || selected === hex}>Set color</Button
      >
    </div>
  </form>
</Popover>

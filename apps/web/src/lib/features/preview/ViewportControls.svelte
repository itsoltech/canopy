<script lang="ts">
  import { viewportSizes } from "@canopy/domain/agent-tool-settings";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    width = 0,
    height = 0,
    enabled,
    onresize,
  }: {
    width?: number;
    height?: number;
    enabled: boolean;
    onresize: (width: number, height: number) => void;
  } = $props();

  const presets = viewportSizes.flatMap((size) => {
    const [w, h] = size.value.split("x").map(Number);

    return w && h ? [{ width: w, height: h, label: size.label }] : [];
  });

  let open = $state(false);
  let widthDraft = $state<number | null>(null);
  let heightDraft = $state<number | null>(null);
  let dirty = $state(false);
  let pending: { width: number; height: number } | undefined = $state();

  $effect(() => {
    const current = { width, height };

    if (pending) {
      if (current.width === pending.width && current.height === pending.height) {
        pending = undefined;
        dirty = false;
        widthDraft = current.width || null;
        heightDraft = current.height || null;
      }

      return;
    }

    if (!dirty) {
      widthDraft = current.width || null;
      heightDraft = current.height || null;
    }
  });

  $effect(() => {
    if (!enabled) open = false;
  });

  function valid(value: number | null): value is number {
    return value !== null && Number.isInteger(value) && value >= 1 && value <= 8192;
  }

  function resize(next: { width: number; height: number }): void {
    pending = next;
    onresize(next.width, next.height);
    open = false;
  }

  function apply(): void {
    if (valid(widthDraft) && valid(heightDraft)) resize({ width: widthDraft, height: heightDraft });
  }

  function choose(preset: { width: number; height: number }): void {
    widthDraft = preset.width;
    heightDraft = preset.height;
    dirty = true;
    resize(preset);
  }
</script>

<Popover bind:open label="Viewport size" placement="top-end" class="w-64">
  {#snippet trigger(props)}
    <button
      type="button"
      class="relative -mr-1 inline-flex h-6 shrink-0 items-center gap-1 rounded px-1 text-muted tabular-nums focus-ring not-disabled:hover:bg-zinc-950/5 not-disabled:hover:text-ink disabled:cursor-default aria-expanded:bg-zinc-950/5 aria-expanded:text-ink dark:not-disabled:hover:bg-white/10 dark:aria-expanded:bg-white/10"
      aria-label={width && height ? `Viewport ${width} × ${height}. Change size` : "Change viewport size"}
      disabled={!enabled}
      {...props}
      {@attach tooltip(enabled ? "Change viewport size" : undefined)}
    >
      {width && height ? `${width} × ${height}` : "Viewport"}
      {#if enabled}<Icon name="chevron-up-down" size="xs" />{/if}
      <TouchTarget />
    </button>
  {/snippet}
  <form
    class="flex flex-col gap-2 p-2"
    onsubmit={(event) => {
      event.preventDefault();
      apply();
    }}
  >
    <p class="px-1 text-xs/4 font-medium text-muted">Viewport size</p>
    <div class="grid grid-cols-2 gap-1">
      {#each presets as preset (preset.label)}
        <button
          type="button"
          class={[
            "rounded-md px-2 py-1 text-left tabular-nums focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/10",
            preset.width === width && preset.height === height && "bg-zinc-950/5 font-medium dark:bg-white/10",
          ]}
          aria-pressed={preset.width === width && preset.height === height}
          onclick={() => choose(preset)}>{preset.label}</button
        >
      {/each}
    </div>
    <div class="flex items-center gap-1.5 border-t border-divider pt-2">
      <Input
        type="number"
        min={1}
        max={8192}
        step={1}
        aria-label="Viewport width"
        name="viewport-width"
        placeholder="1280"
        class="min-w-0 flex-1"
        compact
        steppers={false}
        bind:value={widthDraft}
        oninput={() => (dirty = true)}
      />
      <span class="text-xs text-muted" aria-hidden="true">×</span>
      <Input
        type="number"
        min={1}
        max={8192}
        step={1}
        aria-label="Viewport height"
        name="viewport-height"
        placeholder="800"
        class="min-w-0 flex-1"
        compact
        steppers={false}
        bind:value={heightDraft}
        oninput={() => (dirty = true)}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={!valid(widthDraft) || !valid(heightDraft)}
        >Apply</Button
      >
    </div>
  </form>
</Popover>

<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

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

  function valid(value: number | null): value is number {
    return value !== null && Number.isInteger(value) && value >= 1 && value <= 8192;
  }

  function apply(): void {
    if (!valid(widthDraft) || !valid(heightDraft)) return;

    pending = { width: widthDraft, height: heightDraft };
    onresize(widthDraft, heightDraft);
  }
</script>

<div class="flex max-w-full min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
  <span class="shrink-0 font-medium">Viewport</span>
  <div class="flex max-w-48 min-w-40 flex-1 items-center gap-1">
    <label class="flex min-w-0 flex-1 items-center gap-1">
      <span aria-hidden="true">W</span>
      <Input
        type="number"
        min={1}
        max={8192}
        step={1}
        aria-label="Viewport width"
        name="viewport-width"
        class="min-w-0 flex-1"
        compact
        steppers={false}
        bind:value={widthDraft}
        oninput={() => (dirty = true)}
        disabled={!enabled}
      />
    </label>
    <span class="text-xs text-muted">×</span>
    <label class="flex min-w-0 flex-1 items-center gap-1">
      <span aria-hidden="true">H</span>
      <Input
        type="number"
        min={1}
        max={8192}
        step={1}
        aria-label="Viewport height"
        name="viewport-height"
        class="min-w-0 flex-1"
        compact
        steppers={false}
        bind:value={heightDraft}
        oninput={() => (dirty = true)}
        disabled={!enabled}
      />
    </label>
  </div>
  <Button
    type="button"
    size="sm"
    variant="secondary"
    disabled={!enabled || !valid(widthDraft) || !valid(heightDraft)}
    onclick={apply}>Apply</Button
  >
</div>

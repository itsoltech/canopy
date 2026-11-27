<script lang="ts" module>
  import type { Tone } from "#lib/shared/ui/tone.ts";

  export type PreviewStatus = { label: string; tone: Tone };
</script>

<script lang="ts">
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ViewportControls from "./ViewportControls.svelte";

  let {
    status,
    context,
    focused,
    interactive,
    viewport,
    size,
    onresize,
  }: {
    status?: PreviewStatus | undefined;
    context: string;
    focused: boolean;
    interactive: boolean;
    /** Browser viewport, editable from here. */
    viewport?: { width: number; height: number; enabled: boolean } | undefined;
    /** Frame size of a window or device. */
    size?: { width: number; height: number } | undefined;
    onresize: (width: number, height: number) => void;
  } = $props();
</script>

<div class="flex h-8 shrink-0 items-center gap-2 border-t border-divider px-3 text-xs text-muted">
  {#if status}
    <span class="inline-flex shrink-0 items-center gap-1.5" role="status">
      <StatusDot tone={status.tone} />{status.label}
    </span>
    <span class="shrink-0" aria-hidden="true">·</span>
  {/if}
  <span class="min-w-0 flex-1 truncate" title={context}>{context}</span>
  {#if focused}
    <span class="inline-flex shrink-0 items-center gap-1.5 text-brand-700 dark:text-brand-300">
      <StatusDot tone="sky" pulse />Keyboard active · Esc to release
    </span>
  {:else if interactive}
    <span class="hidden shrink-0 @md:inline">Click the preview to control it</span>
  {/if}
  {#if viewport}
    <ViewportControls width={viewport.width} height={viewport.height} enabled={viewport.enabled} {onresize} />
  {:else if size?.width}
    <span class="shrink-0 tabular-nums">{size.width} × {size.height}</span>
  {/if}
</div>

<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { FileIntake } from "./file-intake.svelte.ts";

  /**
   * Covers a window that takes files while files from outside are dragged over it (`FileIntake.dragging`). It lets
   * every pointer event through, so a drop on the composer still lands at its point. Place it in the area's
   * positioned element; it never takes space. Fades and settles in (motion.css `t-drop`).
   */
  let { intake }: { intake: FileIntake } = $props();
</script>

<div
  class="t-drop pointer-events-none absolute inset-0 z-40 p-2 sm:p-3"
  data-open={intake.dragging || undefined}
  aria-hidden="true"
>
  <div
    class="grid size-full place-items-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/70 backdrop-blur-[2px] dark:border-brand-400 dark:bg-brand-950/60"
  >
    <p
      class="t-drop-label flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-sm/6 font-medium text-zinc-950 shadow-sm ring-1 ring-zinc-950/10 dark:text-white dark:shadow-none dark:ring-white/10"
    >
      <Icon name="paper-clip" tone="inherit" />Drop files to attach
    </p>
  </div>
</div>

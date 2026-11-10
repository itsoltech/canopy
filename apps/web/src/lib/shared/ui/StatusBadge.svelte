<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { statusLook } from "./status.ts";
  import { swap } from "./motion.ts";
  import StatusDot from "./StatusDot.svelte";
  import { badgeTones } from "./tone.ts";

  /** Status of a thread, turn, interaction or worker: dot + label; a new status swaps in. */
  let {
    status,
    compact = false,
    class: className,
  }: { status: string; compact?: boolean; class?: ClassValue } = $props();

  const look = $derived(statusLook(status));
</script>

<span
  class={[
    "inline-flex shrink-0 items-center gap-x-1.5 rounded-md pr-1.5 pl-2 text-sm font-medium whitespace-nowrap ring-1 select-none ring-inset sm:text-xs",
    compact ? "py-0.5 leading-4" : "py-0.5 leading-5",
    badgeTones[look.tone],
    className,
  ]}
>
  {#key look.label}<span class="inline-flex items-center gap-x-1.5" in:swap
      ><StatusDot tone={look.tone} active={look.active} />{look.label}</span
    >{/key}
</span>

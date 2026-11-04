<script lang="ts">
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import type { ClassValue } from "svelte/elements";

  let { status, class: className }: { status: DesktopStatus; class?: ClassValue } = $props();
</script>

<div class={["grid gap-3 text-base/6 sm:text-sm/6", className]} aria-live="polite">
  <p class="flex items-center gap-2">
    <span
      class={[
        "size-2 shrink-0 rounded-full",
        status.worker === "online" ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600",
      ]}
    ></span>
    Worker {status.worker === "online" ? "connected" : status.worker === "connecting" ? "connecting…" : "offline"}
  </p>
  <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
    <dt class="font-medium">Mode</dt>
    <dd class="text-zinc-500 dark:text-zinc-400">
      {status.mode === "local" ? "This computer" : status.mode === "remote" ? "Remote gateway" : "Not configured"}
    </dd>
    <dt class="font-medium">CLIs found</dt>
    <dd class="text-zinc-500 dark:text-zinc-400">
      {Object.entries(status.clis)
        .filter(([, found]) => found)
        .map(([name]) => name)
        .join(", ") || "None — install Claude, Codex or Grok to run agents."}
    </dd>
  </dl>
</div>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Miniature of the app (sidebar, chat, panel, composer) in light or dark, for the scheme picker. */
  let { mode, class: className }: { mode: "light" | "dark"; class?: ClassValue } = $props();
  const dark = $derived(mode === "dark");
</script>

<div class={["flex h-full w-full overflow-hidden", dark ? "bg-black" : "bg-white", className]} aria-hidden="true">
  <div class={["grid w-1/5 content-start gap-1.5 border-r p-2", dark ? "border-white/10 bg-zinc-950" : "border-zinc-950/5 bg-zinc-50"]}>
    <div class={["h-2 rounded-full", dark ? "bg-white/15" : "bg-zinc-950/10"]}></div>
    <div class={["h-1.5 w-4/5 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></div>
    <div class={["h-1.5 w-3/5 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></div>
  </div>
  <div class="flex flex-1 flex-col justify-between p-2.5">
    <div class="grid gap-1.5">
      <div class={["ml-auto h-2.5 w-2/5 rounded-full", dark ? "bg-white/15" : "bg-zinc-950/10"]}></div>
      <div class={["h-1.5 w-3/5 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></div>
      <div class={["h-1.5 w-2/5 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></div>
    </div>
    <div class={["flex items-center justify-between rounded-md px-1.5 py-1 ring-1", dark ? "bg-zinc-950 ring-white/10" : "bg-white ring-zinc-950/10"]}>
      <div class={["h-1 w-1/3 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></div>
      <div class="size-2 rounded-full bg-brand-500"></div>
    </div>
  </div>
  <div class="w-1/4 p-2">
    <div class={["grid gap-1 rounded-md p-1.5 ring-1", dark ? "bg-zinc-950 ring-white/10" : "bg-white ring-zinc-950/10"]}>
      <div class="flex items-center gap-1"><span class="size-1 rounded-full bg-emerald-500"></span><span class={["h-1 flex-1 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></span></div>
      <div class="flex items-center gap-1"><span class="size-1 rounded-full bg-sky-500"></span><span class={["h-1 flex-1 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></span></div>
      <div class="flex items-center gap-1"><span class="size-1 rounded-full bg-amber-500"></span><span class={["h-1 flex-1 rounded-full", dark ? "bg-white/10" : "bg-zinc-950/6"]}></span></div>
    </div>
  </div>
</div>

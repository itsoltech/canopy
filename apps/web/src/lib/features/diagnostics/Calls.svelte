<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { callKey, errorCount, measured } from "@canopy/domain/diagnostics";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CallDetails from "./CallDetails.svelte";

  let {
    computer,
    next,
    previous,
    offset,
  }: { computer: ui.ComputerDiagnostics; next: () => void; previous: () => void; offset: number } = $props();

  let selected = $state<ui.DiagnosticsCall>();
  let open = $state(false);
  const calls = $derived(computer.calls);

  function details(call: ui.DiagnosticsCall) {
    selected = call;
    open = true;
  }
</script>

<SettingsGroup
  title="Calls"
  description={`${computer.name} · ${computer.totalMethods} methods · ${computer.resolutionSeconds} s resolution`}
>
  {#if !calls.length}
    <div class="grid gap-1 p-4">
      <p>No calls yet</p>
      <p class="text-sm text-muted">Use Canopy to collect performance data.</p>
    </div>
  {:else}
    <div class="hidden overflow-x-auto lg:block">
      <table class="w-full table-fixed text-left text-sm tabular-nums">
        <thead
          ><tr class="text-muted"
            ><th class="w-2/5 p-3">Method</th><th class="p-2">Calls/min</th><th class="p-2">p95</th><th class="p-2"
              >Errors</th
            ><th class="p-2">In flight</th></tr
          ></thead
        >
        <tbody>
          {#each calls as call (callKey(call))}
            <tr class="border-t border-divider"
              ><td class="p-3"
                ><button
                  class="block w-full text-left wrap-anywhere text-brand-600 dark:text-brand-400"
                  onclick={() => details(call)}
                  >{call.method.split("/").at(-1)}<span class="block text-xs text-muted"
                    >{call.layer} · {call.stream ? "Stream lifetime" : "Unary"}</span
                  ></button
                ></td
              ><td class="p-2">{call.callsPerMinute.toFixed(1)}</td><td class="p-2">{measured(call.durationMs)}</td><td
                class="p-2">{errorCount(call).toString()}</td
              ><td class="p-2">{call.inFlight}</td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
    <div class="divide-y divide-divider lg:hidden">
      {#each calls as call (callKey(call))}
        <button class="grid min-h-12 w-full gap-2 p-4 text-left text-sm" onclick={() => details(call)}>
          <span class="font-medium wrap-anywhere">{call.method.split("/").at(-1)}</span>
          <span class="text-xs text-muted">{call.layer} · {call.stream ? "Stream lifetime" : "Unary"}</span>
          <span class="flex flex-wrap gap-x-4 gap-y-1 text-muted tabular-nums"
            ><span>{call.callsPerMinute.toFixed(1)} calls/min</span><span>p95 {measured(call.durationMs)}</span><span
              >{errorCount(call).toString()} errors</span
            ><span>{call.inFlight} in flight</span></span
          >
        </button>
      {/each}
    </div>
  {/if}
  {#if offset || computer.nextOffset}<div class="flex items-center justify-between gap-3 p-3">
      <Button onclick={previous} disabled={!offset}>Previous</Button><span class="text-sm text-muted"
        >{offset + 1}–{offset + calls.length} of {computer.totalMethods}</span
      ><Button onclick={next} disabled={!computer.nextOffset}>Next</Button>
    </div>{/if}
</SettingsGroup>
<CallDetails call={selected} bind:open observedSeconds={computer.observedSeconds} />

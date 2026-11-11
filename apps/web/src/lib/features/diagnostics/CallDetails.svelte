<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { bytes, byteRate, messageClasses, duration, grpcCodes, measured } from "@canopy/domain/diagnostics";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DatabaseFamilies from "./DatabaseFamilies.svelte";

  let {
    call,
    open = $bindable(false),
    observedSeconds,
  }: { call: ui.DiagnosticsCall | undefined; open?: boolean; observedSeconds: number } = $props();
</script>

<Dialog bind:open title="RPC details">
  {#if call}
    <p class="mb-4 text-sm break-all text-muted">{call.method}</p>
    <dl class="grid grid-cols-2 gap-3 text-sm tabular-nums">
      <div>
        <dt class="text-muted">Layer</dt>
        <dd>{call.layer}</dd>
      </div>
      <div>
        <dt class="text-muted">Type</dt>
        <dd>{call.stream ? "Stream" : "Unary"}</dd>
      </div>
      <div>
        <dt class="text-muted">Started / completed</dt>
        <dd>{call.started.toString()} / {call.completed.toString()}</dd>
      </div>
      <div>
        <dt class="text-muted">In flight / peak</dt>
        <dd>{call.inFlight} / {call.maxInFlight}</dd>
      </div>
      <div>
        <dt class="text-muted">p50 / p95</dt>
        <dd>{measured(call.durationMs, "p50")} / {measured(call.durationMs)}</dd>
      </div>
      <div>
        <dt class="text-muted">p99 / max</dt>
        <dd>{measured(call.durationMs, "p99")} / {measured(call.durationMs, "max")}</dd>
      </div>
      <div>
        <dt class="text-muted">Request size p95</dt>
        <dd>{bytes(call.requestBytes)}</dd>
      </div>
      <div>
        <dt class="text-muted">Response size p95</dt>
        <dd>{bytes(call.responseBytes)}</dd>
      </div>
      {#if call.stream}
        <div>
          <dt class="text-muted">Request bytes/s</dt>
          <dd>{byteRate(call.requestBytes, observedSeconds)}</dd>
        </div>
        <div>
          <dt class="text-muted">Response bytes/s</dt>
          <dd>{byteRate(call.responseBytes, observedSeconds)}</dd>
        </div>
        <div>
          <dt class="text-muted">First message p95</dt>
          <dd>{measured(call.firstMessageMs)}</dd>
        </div>
        <div>
          <dt class="text-muted">Oldest active</dt>
          <dd>{duration(call.oldestActiveMs)}</dd>
        </div>
        <div>
          <dt class="text-muted">Request messages/s</dt>
          <dd>{observedSeconds ? (Number(call.requestMessages) / observedSeconds).toFixed(2) : "Not enough data"}</dd>
        </div>
        <div>
          <dt class="text-muted">Response messages/s</dt>
          <dd>{observedSeconds ? (Number(call.responseMessages) / observedSeconds).toFixed(2) : "Not enough data"}</dd>
        </div>
      {/if}
    </dl>
    {#if call.stream}<div class="mt-4 grid gap-2 text-sm text-muted">
        <p>Request messages: {messageClasses(call, "request")}</p>
        <p>Response messages: {messageClasses(call, "response")}</p>
      </div>{/if}
    <p class="mt-4 text-sm text-muted">
      Percentiles use fixed histogram buckets with up to 19% quantization. Max is exact.{(call.durationMs?.samples ??
        0n) < 1000n
        ? " p99 has a small sample."
        : ""}
    </p>
    {#if call.incomplete}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300">
        Some measurements are missing.
      </p>{/if}
    <div class="mt-4"><DatabaseFamilies families={call.database} linked /></div>
    <dl class="mt-4 grid gap-2 text-sm tabular-nums">
      {#each call.codes as count, code (code)}
        {#if count}<div class="flex justify-between gap-3">
            <dt>{grpcCodes[code]}</dt>
            <dd>{count.toString()}</dd>
          </div>{/if}
      {/each}
    </dl>
  {/if}
</Dialog>

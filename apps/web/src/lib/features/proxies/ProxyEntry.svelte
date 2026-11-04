<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { proxyCall, proxyKinds } from "./proxies.ts";
  import ProxyMappings from "./ProxyMappings.svelte";

  let {
    proxy,
    onedit,
    ondelete,
    class: className,
  }: { proxy: ui.Proxy; onedit: () => void; ondelete: () => void; class?: ClassValue } = $props();

  let testing = $state(false);
  let deleting = $state(false);
  let result = $state<ui.TestProxyResponse>();
  let failure = $state<string>();

  async function testConnection() {
    testing = true;
    failure = undefined;

    try {
      result = await proxyCall("test", { id: proxy.id });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      testing = false;
    }
  }

  async function remove() {
    if (!confirm(`Delete ${proxy.name}?`)) return;
    deleting = true;
    failure = undefined;

    try {
      await proxyCall("delete", { id: proxy.id, expectedRevision: proxy.revision });
      ondelete();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      deleting = false;
    }
  }
</script>

<section
  aria-label={proxy.name}
  class={["grid min-w-0 gap-3 border-t border-zinc-950/10 py-3 first:border-0 dark:border-white/10", className]}
>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-lg font-semibold text-balance text-zinc-950 dark:text-white">{proxy.name}</h2>
      <p class="text-base/6 break-all text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{proxy.baseUrl}</p>
    </div>
    <Badge tone={proxy.secretSet ? "emerald" : "amber"}>{proxy.secretSet ? "Secret set" : "Secret missing"}</Badge>
  </div>
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    {proxyKinds.find((k) => k.value === proxy.kind)?.label} · {proxy.usedBy.length
      ? `Used by ${proxy.usedBy.join(", ")}`
      : "No profiles yet"}
  </p>
  <ProxyMappings kind={proxy.kind} baseUrl={proxy.baseUrl} />
  {#if result}<Alert tone={result.ok ? "info" : "error"}
      >{result.detail}{result.ok ? ` · ${result.modelCount} models` : ""}</Alert
    >{/if}
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  <div class="flex flex-wrap gap-2">
    <Button size="sm" onclick={testConnection} loading={testing}>Test connection</Button>
    <Button size="sm" onclick={onedit}>Edit</Button>
    <Button
      size="sm"
      variant="ghost"
      onclick={remove}
      loading={deleting}
      disabled={proxy.usedBy.length > 0}
      title={proxy.usedBy.length ? `Used by: ${proxy.usedBy.join(", ")}` : undefined}>Delete</Button
    >
  </div>
</section>

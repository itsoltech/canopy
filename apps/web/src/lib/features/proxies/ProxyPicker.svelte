<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { Provider, type ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import ProxyDialog from "./ProxyDialog.svelte";
  import { listProxies, supportsHarness } from "./proxies.ts";

  let {
    harness,
    value = $bindable(""),
    inherited = false,
    error,
    class: className,
  }: {
    harness: Provider;
    value?: string;
    inherited?: boolean;
    error?: string | undefined;
    class?: ClassValue;
  } = $props();

  let proxies = $state<ui.Proxy[]>([]);
  let adding = $state(false);
  let loading = $state(true);
  let failure = $state<string>();

  const options = $derived([
    ...(inherited ? [{ value: "", label: "Use the instance's proxy" }] : []),
    ...proxies
      .filter((p) => supportsHarness(p, harness))
      .map((p) => ({ value: p.id, label: p.name, description: p.baseUrl })),
  ]);

  async function reload() {
    loading = true;
    failure = undefined;

    try {
      proxies = await listProxies();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void reload();
  });
</script>

<div class={["grid gap-3", className]}>
  <Field label="Proxy" {error} description="Choose a saved connection supported by this harness.">
    <Select
      name="proxy"
      bind:value
      {options}
      disabled={loading}
      placeholder={loading ? "Loading proxies…" : "Choose a proxy…"}
    />
  </Field>
  {#if !loading && !options.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      No compatible proxies yet. Add one to continue.
    </p>{/if}
  {#if failure}<Alert tone="error">{failure}<Button size="sm" onclick={reload}>Try again</Button></Alert>{/if}
  <div><Button size="sm" onclick={() => (adding = true)}>Add proxy</Button></div>
</div>
<ProxyDialog
  bind:open={adding}
  onsaved={(proxy) => {
    proxies = [...proxies, proxy];
    if (supportsHarness(proxy, harness)) value = proxy.id;
  }}
/>

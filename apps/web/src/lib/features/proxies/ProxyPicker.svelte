<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, type ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SensitiveUrl from "#lib/shared/ui/SensitiveUrl.svelte";
  import ProxyDialog from "./ProxyDialog.svelte";
  import { replaceProxy, sharedProxies, supportsHarness } from "./proxies.ts";

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

  const read = sharedProxies();
  const proxies = $derived(read.data?.proxies ?? []);
  let adding = $state(false);
  const loading = $derived(!read.snapshot.loaded && !read.snapshot.error);
  const failure = $derived(read.snapshot.error || undefined);

  const options = $derived([
    ...(inherited ? [{ value: "", label: "Use the instance's proxy" }] : []),
    ...proxies.filter((p) => supportsHarness(p, harness)).map((p) => ({ value: p.id, label: p.name })),
  ]);

  const reload = () => void read.reload().catch(() => {});
</script>

<div class={["grid gap-3", className]}>
  <Field label="Proxy" {error} description="Only compatible proxies appear here.">
    <Select
      name="proxy"
      bind:value
      {options}
      disabled={loading}
      placeholder={loading ? "Loading proxies…" : "Choose a proxy…"}
    />
  </Field>
  {#if proxies.find((proxy) => proxy.id === value)?.baseUrl}
    <p class="min-w-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <SensitiveUrl value={proxies.find((proxy) => proxy.id === value)?.baseUrl ?? ""} />
    </p>
  {/if}
  {#if !loading && !options.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      No compatible proxies yet.
    </p>{/if}
  {#if failure}<Alert tone="error">{failure}<Button size="sm" onclick={reload}>Try again</Button></Alert>{/if}
  <div><Button size="sm" onclick={() => (adding = true)}>Add proxy</Button></div>
</div>
<ProxyDialog
  bind:open={adding}
  onsaved={(proxy) => {
    replaceProxy(read, proxy);
    if (supportsHarness(proxy, harness)) value = proxy.id;
  }}
/>

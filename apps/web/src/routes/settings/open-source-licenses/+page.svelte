<script lang="ts">
  import { Schema } from "effect";
  import { onMount } from "svelte";
  import { applicationName } from "#lib/application-name.ts";
  import { bodyJson } from "#lib/shared/json.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  const PackageLicense = Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    license: Schema.String,
    files: Schema.Array(Schema.Struct({ name: Schema.String, text: Schema.String })),
  });

  type PackageLicense = typeof PackageLicense.Type;

  const decode = Schema.decodeUnknownSync(Schema.Array(PackageLicense));
  const request = new AbortController();
  let packages = $state.raw<readonly PackageLicense[]>();
  let failed = $state(false);
  let query = $state("");

  const matches = $derived.by(() => {
    const search = query.trim().toLowerCase();

    if (!packages) return [];

    if (!search) return packages;

    const terms = search.split(/\s+/);

    return packages.filter(({ name, version, license }) => {
      const searchable = `${name} ${version} ${license}`.toLowerCase();

      return terms.every((term) => searchable.includes(term));
    });
  });

  async function load() {
    failed = false;

    try {
      const response = await fetch("/open-source-licenses.json", {
        cache: "no-cache",
        mode: "same-origin",
        signal: request.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      packages = decode(await bodyJson(response));
    } catch {
      if (!request.signal.aborted) failed = true;
    }
  }

  onMount(() => {
    void load();

    return () => request.abort();
  });
</script>

<svelte:head><title>Open-source licenses · Settings · {applicationName}</title></svelte:head>

{#snippet packageSummary(entry: PackageLicense)}
  <span class="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-base/5">
    <span class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <span class="min-w-0 font-medium wrap-anywhere select-text">{entry.name}</span>
      <span class="min-w-0 text-sm/5 wrap-anywhere text-zinc-500 tabular-nums select-text">{entry.version}</span>
    </span>
    <span class="min-w-0 text-sm/5 wrap-anywhere text-zinc-500 select-text">{entry.license}</span>
  </span>
{/snippet}

{#if failed}
  <Alert tone="error" title="Could not load open-source licenses">
    {#snippet actions()}<Button size="sm" onclick={load}>Retry</Button>{/snippet}
  </Alert>
{:else if !packages}
  <p class="flex items-center gap-2 px-1 py-2 text-sm/5 text-zinc-500" role="status">
    <Spinner /> Loading open-source licenses…
  </p>
{:else if !packages.length}
  <EmptyState title="No open-source packages listed" />
{:else}
  <div class="grid min-w-0 gap-3">
    <SearchField
      label="Search packages"
      name="license-package-search"
      placeholder="Search packages"
      bind:value={query}
    />
    {#if matches.length}
      <SettingsCard>
        <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/8">
          {#each matches as entry (entry)}
            <li>
              {#if entry.files.length}
                <Disclosure
                  align="center"
                  summaryClass="min-h-(--settings-target) px-(--settings-row-x) py-(--settings-row-y) focus-visible:-outline-offset-2 hover:bg-zinc-950/2.5 dark:hover:bg-white/2.5"
                >
                  {#snippet summary()}{@render packageSummary(entry)}{/snippet}
                  <div class="grid min-w-0 gap-4 px-(--settings-row-x) pt-1 pb-3">
                    {#each entry.files as file (file)}
                      <div class="grid min-w-0 gap-1.5 select-text">
                        <p class="text-sm/5 font-medium wrap-anywhere">{file.name}</p>
                        <pre
                          class="min-w-0 rounded-lg bg-zinc-950/4 px-3 py-2 font-mono text-sm/6 wrap-anywhere whitespace-pre-wrap text-zinc-700 dark:bg-white/5 dark:text-zinc-300">{file.text}</pre>
                      </div>
                    {/each}
                  </div>
                </Disclosure>
              {:else}
                <div
                  class="flex min-h-(--settings-target) items-center gap-2 px-(--settings-row-x) py-(--settings-row-y)"
                >
                  <span class="size-4 shrink-0" aria-hidden="true"></span>
                  {@render packageSummary(entry)}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </SettingsCard>
    {:else}
      <div role="status"><EmptyState title="No packages match your search" /></div>
    {/if}
  </div>
{/if}

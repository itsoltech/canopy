<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import GatewayUnavailable from "#lib/shared/ui/GatewayUnavailable.svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { splitId } from "@canopy/domain/computers";
  import { onMount } from "svelte";

  // A linked computer's thread while that computer is away: its reason ("Travel laptop is unreachable since …"), not a gateway outage.
  const away = $derived(
    page.error?.scope === "computer" ||
      (Boolean(splitId(page.params["threadId"] ?? page.params["botId"] ?? "").node) &&
        (page.status === 503 || page.status === 409)),
  );

  let reconnecting = $state(true);

  onMount(() => {
    const timer = setTimeout(() => (reconnecting = false), 12_000);

    return () => clearTimeout(timer);
  });

  // Part of the app did not download: retrying the gateway cannot help, a reload fetches the app again.
  const assets = $derived(page.error?.scope === "assets");
  const unavailable = $derived((page.status >= 500 && !assets) || away);
  let retrying = $state(false);

  async function retry() {
    if (retrying) return;
    retrying = true;

    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  }

  $effect(() => {
    if (!unavailable) return;

    const timer = setInterval(() => {
      if (!document.hidden && navigator.onLine) void retry();
    }, 3000);

    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{page.status} · {applicationName}</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>{page.status === 404 ? "Not found" : "Error"}</Crumb></TopBar>
  {#if assets}
    <div class="grid min-h-0 flex-1 scroll-stable place-items-center overflow-y-auto p-6">
      <div class="flex max-w-md flex-col items-center text-center">
        <Icon name="arrow-path" class="fill-zinc-400 dark:fill-zinc-500" />
        <h1 class="mt-3 text-2xl font-semibold tracking-tight text-balance">{page.error?.message}</h1>
        <p class="mt-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Part of the app did not download. Check the connection, then reload.
        </p>
        <div class="mt-6 flex gap-2"><Button variant="primary" onclick={() => location.reload()}>Reload</Button></div>
      </div>
    </div>
  {:else if unavailable}
    <div class="min-h-0 flex-1">
      {#if away}
        <GatewayUnavailable
          {retry}
          {retrying}
          icon="link"
          title={page.error?.message ?? "The other computer is away"}
          description="This page opens again when that computer reconnects. Retrying automatically."
        />
      {:else}
        <GatewayUnavailable
          {retry}
          {retrying}
          title={reconnecting ? "Reconnecting…" : "Can't reach the gateway"}
          description={reconnecting ? "Retrying automatically. Your work is kept." : undefined}
        />
      {/if}
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 scroll-stable place-items-center overflow-y-auto p-6">
      <div class="flex max-w-md flex-col items-center text-center">
        <Icon name="question-mark-circle" class="fill-zinc-400 dark:fill-zinc-500" />
        <p class="mt-3 font-mono text-sm/6 text-zinc-500 dark:text-zinc-400">{page.status}</p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight text-balance">
          {page.error?.message ?? "Something went wrong"}
        </h1>
        <p class="mt-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          The page you are looking for does not exist or is no longer available.
        </p>
        <div class="mt-6 flex gap-2"><ButtonLink href="/" variant="primary">New thread</ButtonLink></div>
      </div>
    </div>
  {/if}
</div>

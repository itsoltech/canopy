<script lang="ts">
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import GatewayUnavailable from "#lib/shared/ui/GatewayUnavailable.svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  const unavailable = $derived(page.status >= 500);
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

<svelte:head><title>{page.status} · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>{page.status === 404 ? "Not found" : "Error"}</Crumb></TopBar>
  {#if unavailable}
    <div class="min-h-0 flex-1"><GatewayUnavailable {retry} {retrying} /></div>
  {:else}
    <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">
      <div class="flex max-w-md flex-col items-center text-center">
        <Icon name="question-mark-circle" class="fill-zinc-400 dark:fill-zinc-500" />
        <p class="mt-3 font-mono text-sm/6 text-zinc-500 dark:text-zinc-400">{page.status}</p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight text-balance">{page.error?.message ?? "Something went wrong"}</h1>
        <p class="mt-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The page you are looking for does not exist or is no longer available.</p>
        <div class="mt-6 flex gap-2"><ButtonLink href="/" variant="primary">New thread</ButtonLink></div>
      </div>
    </div>
  {/if}
</div>

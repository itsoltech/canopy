<script lang="ts">
  import { page } from "$app/state";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  const unavailable = $derived(page.status >= 500);
</script>

<svelte:head><title>{page.status} · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>{page.status === 404 ? "Not found" : "Error"}</Crumb></TopBar>
  <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">
    <div class="flex max-w-md flex-col items-center text-center">
      <Icon name={unavailable ? "signal-slash" : "question-mark-circle"} class="fill-zinc-400 dark:fill-zinc-500" />
      <p class="mt-3 font-mono text-sm/6 text-zinc-500 dark:text-zinc-400">{page.status}</p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight text-balance">{unavailable ? "Can't reach the gateway" : (page.error?.message ?? "Something went wrong")}</h1>
      <p class="mt-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {unavailable ? "The gateway did not answer. It may be restarting; try again in a moment." : "The page you are looking for does not exist or is no longer available."}
      </p>
      <div class="mt-6 flex gap-2">
        {#if unavailable}<ButtonLink href={page.url.pathname} variant="primary" icon="arrow-path" data-sveltekit-reload>Try again</ButtonLink>{/if}
        <ButtonLink href="/" variant={unavailable ? "secondary" : "primary"}>New thread</ButtonLink>
      </div>
    </div>
  </div>
</div>

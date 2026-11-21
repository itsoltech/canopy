<script lang="ts">
  import type { Snippet } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { applicationName } from "#lib/application-name.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SetupFrame from "./SetupFrame.svelte";

  let { title, description, children }: { title: string; description?: string; children: Snippet } = $props();

  let previous = $state<string>();

  afterNavigate(({ from, to, type }) => {
    if (type === "link" && from?.route.id && from.url.origin === to?.url.origin) previous = from.url.href;
  });

  function goBack(event: MouseEvent) {
    if (!previous || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.back();
  }
</script>

<svelte:head><title>{title} · {applicationName}</title></svelte:head>

<SetupFrame>
  <div>
    <ButtonLink href={previous ?? "/setup"} variant="ghost" icon="arrow-left" onclick={goBack}>Back</ButtonLink>
  </div>
  <header class="grid gap-3">
    <h1 class="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
    {#if description}<p class="text-base/7 text-pretty text-muted">{description}</p>{/if}
  </header>
  {@render children()}
</SetupFrame>

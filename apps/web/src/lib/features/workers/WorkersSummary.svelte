<script lang="ts">
  import { workerChoices } from "@canopy/domain/worker-choices";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const canManage = $derived(capabilities?.supports("/settings/workers") ?? true);

  const choices = $derived(
    workerChoices(overview.workers, (worker) => ({
      computer: overview.machine(worker.nodeId) ?? "This computer",
      online: worker.online,
      status: worker.online ? "Online" : "Offline",
    })),
  );

  const rowClass =
    "flex min-h-10 items-center gap-2 rounded-md px-2 text-base/6 sm:min-h-7 sm:text-sm/5 pointer-coarse:min-h-11";
</script>

<div class="grid min-w-0 gap-2 p-3">
  <h2 class="text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Workers</h2>
  {#if choices.length}
    <ul role="list" class="-mx-2 grid max-h-[min(24rem,50dvh)] min-w-0 overflow-y-auto overscroll-contain p-0.5">
      {#each choices as choice (choice.worker.id)}
        <li class="min-w-0">
          {#snippet content()}
            <StatusDot tone={choice.online ? "emerald" : "neutral"} />
            <TruncatedText text={choice.worker.name} class="font-medium" />
            {#if choice.duplicate}<TruncatedText
                text={choice.computer}
                class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
              />{/if}
            <span class="ml-auto shrink-0 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{choice.status}</span
            >
          {/snippet}
          {#if canManage}
            <a
              href={`/settings/workers/${encodeURIComponent(choice.worker.id)}`}
              onclick={onclose}
              class={[rowClass, "focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5"]}>{@render content()}</a
            >
          {:else}
            <div class={rowClass}>{@render content()}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">No workers yet</p>
  {/if}
  {#if canManage}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <ButtonLink href="/settings/workers?add=1" icon="plus" onclick={onclose}>Add worker</ButtonLink>
      <ButtonLink href="/settings/workers" variant="text" onclick={onclose}>Open worker settings</ButtonLink>
    </div>
  {/if}
</div>

<script lang="ts">
  import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import InstanceMark from "#lib/features/providers/InstanceMark.svelte";
  import { instanceLabel } from "#lib/features/threads/providers.ts";
  import { cliLabel } from "#lib/features/workers/cli-tools.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { setupAgentRows } from "./setup-agent.ts";

  let { worker }: { worker: ui.Worker } = $props();
  const id = $props.id();
  const catalog = useModelCatalog();
  const rows = $derived(setupAgentRows(worker, catalog.of(worker.id)));
  const workerId = $derived(encodeURIComponent(worker.id));
  const providersHref = $derived(`/settings/providers?worker=${workerId}`);

  const statuses = {
    ready: "Ready",
    installing: "Installing…",
    missing_cli: "CLI not installed",
    unknown_cli: "CLI status unknown",
    cli_error: "CLI could not start",
    syncing: "Applying settings…",
    checking_models: "Checking models…",
    turned_off: "CLI installed · Device login is off",
    signed_out: "CLI installed · Not signed in",
    expired: "CLI installed · Sign-in expired",
    unavailable: "CLI installed · No model available",
  };
</script>

<div class="grid min-w-0 gap-3 p-4">
  <p class="text-sm/5 break-words text-zinc-500 dark:text-zinc-400">On “{worker.name}”</p>
  <InsetList>
    {#each rows as { provider, status, instance } (provider)}
      {@const harness = Provider[provider]}
      {@const name = cliLabel(harness)}
      {@const needsCli =
        status === "missing_cli" || status === "unknown_cli" || status === "cli_error" || status === "installing"}
      {@const instanceName =
        instance?.kind === ProviderProfileKind.CLIPROXYAPI
          ? instance.label || instance.account?.proxyName || "Proxy"
          : instance && instanceLabel(instance)}
      {@const href = needsCli
        ? `/settings/workers/${workerId}#agent-clis`
        : instance
          ? `${providersHref}&instance=${encodeURIComponent(instanceKeyOf(instance))}${status === "turned_off" ? "&view=list" : ""}`
          : `${providersHref}&add=device&provider=${provider}`}
      {@const action = needsCli
        ? "Open Agent CLIs"
        : status === "signed_out" || status === "expired"
          ? "Open device login"
          : "Open provider settings"}
      <li
        class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
      >
        <InstanceMark instance={{ harness, accentColor: instance?.accentColor ?? "" }} />
        <div class="min-w-0">
          <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{name}</p>
          <p class="flex items-baseline gap-1.5 text-sm/5 text-zinc-600 dark:text-zinc-400" role="status">
            {#if status === "ready"}<StatusDot tone="emerald" />{/if}
            <span class="min-w-0 break-words">
              {statuses[status]}{status === "ready" && instanceName ? ` · ${instanceName}` : ""}
            </span>
          </p>
        </div>
        {#if status !== "ready"}
          <ButtonLink
            {href}
            aria-label={`${action} for ${name}`}
            class="col-start-2 justify-self-start sm:col-start-auto">{action}</ButtonLink
          >
        {/if}
      </li>
    {/each}
  </InsetList>
</div>

<section class="flex flex-wrap items-center justify-between gap-3 p-4" aria-labelledby={id}>
  <div class="min-w-0">
    <h3 {id} class="text-base/6 font-semibold text-zinc-950 dark:text-white">Use a proxy</h3>
    <p class="text-sm/6 text-zinc-600 dark:text-zinc-400">Choose a proxy or add a compatible endpoint.</p>
  </div>
  <ButtonLink href={`${providersHref}&add=proxy`}>Choose a proxy</ButtonLink>
</section>

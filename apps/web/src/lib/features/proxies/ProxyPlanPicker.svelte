<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { proxyAutomaticPlanLabel, proxyPlanOptions } from "@canopy/domain/proxy-capacity";
  import Select from "#lib/shared/ui/Select.svelte";
  import { proxyCall } from "./proxies.ts";

  let {
    proxyId,
    account,
    onread,
  }: {
    proxyId: string;
    account: ui.ProxyAccount;
    onread: (accounts: ui.ProxyAccounts) => void;
  } = $props();

  let busy = $state(false);
  let failure = $state(false);
  let value = $state("0");

  $effect(() => {
    value = String(account.manualPlan ?? 0);
  });

  const options = $derived([
    { value: "0", label: proxyAutomaticPlanLabel(account) },
    ...proxyPlanOptions(account.provider).map(({ plan, label }) => ({ value: String(plan), label })),
  ]);

  async function choose(choice: string) {
    const plan = proxyPlanOptions(account.provider).find((option) => String(option.plan) === choice)?.plan ?? 0;
    busy = true;
    failure = false;

    try {
      onread(await proxyCall("plan", { proxyId, accountKey: account.planKey, plan }));
    } catch {
      failure = true;
      value = String(account.manualPlan ?? 0);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-1">
  <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <div class="max-w-60 min-w-0 flex-1">
      <Select
        inline
        aria-label="Account plan"
        bind:value
        {options}
        disabled={busy || !account.planKey}
        onchange={(value) => void choose(value)}
      />
    </div>
    <p class="min-h-5 w-24 shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">
      {busy ? "Saving plan…" : account.manualPlan !== undefined ? "Set manually" : ""}
    </p>
  </div>
  {#if failure}<p class="text-sm/5 text-red-600 sm:text-xs/5 dark:text-red-400" role="alert">
      Could not save the plan. Choose it again to retry.
    </p>{/if}
</div>

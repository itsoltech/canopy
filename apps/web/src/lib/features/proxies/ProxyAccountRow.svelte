<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { ProviderUsageSnapshotSchema, type ui } from "@canopy/contracts";
  import { proxyAccountLook, proxyAccountMark, proxyProviderName, proxyPlanName } from "@canopy/domain/proxy-accounts";
  import { proxyPlanWeight } from "@canopy/domain/proxy-capacity";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import UsageMeters from "#lib/features/providers/UsageMeters.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Sensitive from "#lib/shared/ui/Sensitive.svelte";
  import ProxyPlanPicker from "./ProxyPlanPicker.svelte";

  /**
   * One upstream account of a proxy: provider mark, account, status badge, the limits the proxy last saw and its
   * last message. Every text is the gateway's sanitized plain text and renders as text, never as HTML.
   */
  let {
    account,
    compact = false,
    proxyId,
    onread,
  }: {
    account: ui.ProxyAccount;
    compact?: boolean;
    proxyId?: string;
    onread?: (accounts: ui.ProxyAccounts) => void;
  } = $props();

  const look = $derived(proxyAccountLook(account.status));
  const mark = $derived(proxyAccountMark(account.provider));
  const plan = $derived(proxyPlanName(account.plan));
  const weight = $derived(proxyPlanWeight(account));

  const usage = $derived(
    create(ProviderUsageSnapshotSchema, {
      windows: compact
        ? [...account.windows].sort(
            (a, b) => (b.reached ? 100 : (b.usedPercent ?? -1)) - (a.reached ? 100 : (a.usedPercent ?? -1)),
          )
        : account.windows,
    }),
  );

  const until = $derived(
    account.retryAt
      ? timestampDate(account.retryAt).toLocaleString(undefined, {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
  );
</script>

<li class={["grid min-w-0 gap-1.5 py-2", !compact && "px-3"]}>
  <div class="flex min-w-0 items-center gap-2">
    {@render providerMark()}
    {#if !proxyId || !onread}<div class="max-w-24 shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {plan ?? "Unknown plan"}{!weight.unknown ? ` · ×${weight.units}` : ""}
      </div>{/if}
    <div class="flex min-w-0 flex-1 items-center text-base/6 text-zinc-950 sm:text-sm/6 dark:text-white">
      {#if account.label}<Sensitive value={account.label} label="Account identity" truncate />{:else}Unnamed account{/if}
    </div>
    {#if !compact || account.status !== "active"}<Badge tone={look.tone} compact>{look.label}</Badge>{/if}
  </div>
  {#if proxyId && onread}<ProxyPlanPicker {proxyId} {account} {onread} />{/if}
  {#if plan && weight.unknown}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      Unknown plan · capacity counted as ×1
    </p>{/if}
  {#if until || account.detail}
    <p class="line-clamp-2 text-sm/5 text-pretty break-words text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {#if until}Until {until}{/if}
      {#if account.detail}<Sensitive value={account.detail} label="Account details" />{/if}
    </p>
  {/if}
  <UsageMeters {usage} showPace={!compact} />
</li>

{#snippet providerMark()}
  {#if mark}<ProviderIcon provider={mark} label={proxyProviderName(account.provider)} class="shrink-0" />{:else}<span
      class="max-w-24 shrink-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
      >{proxyProviderName(account.provider)}</span
    >{/if}
{/snippet}

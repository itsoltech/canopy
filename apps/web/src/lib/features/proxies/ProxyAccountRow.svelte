<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { ProviderUsageSnapshotSchema, type ui } from "@canopy/contracts";
  import { proxyAccountLook, proxyAccountMark, proxyProviderName } from "@canopy/domain/proxy-accounts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import UsageMeters from "#lib/features/providers/UsageMeters.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";

  /**
   * One upstream account of a proxy: provider mark, account, status badge, the limits the proxy last saw and its
   * last message. Every text is the gateway's sanitized plain text and renders as text, never as HTML.
   */
  let { account }: { account: ui.ProxyAccount } = $props();
  const look = $derived(proxyAccountLook(account.status));
  const mark = $derived(proxyAccountMark(account.provider));
  const usage = $derived(create(ProviderUsageSnapshotSchema, { windows: account.windows }));

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

<li class="grid min-w-0 gap-1.5 px-3 py-2">
  <div class="flex min-w-0 items-center gap-2">
    {#if mark}<ProviderIcon provider={mark} label={proxyProviderName(account.provider)} class="shrink-0" />{:else}<span
        class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
        >{proxyProviderName(account.provider)}</span
      >{/if}
    <span class="min-w-0 flex-1 truncate text-base/6 text-zinc-950 sm:text-sm/6 dark:text-white" title={account.label}
      >{account.label || "Unnamed account"}</span
    >
    <Badge tone={look.tone} compact>{look.label}</Badge>
  </div>
  {#if until || account.detail}
    <p class="line-clamp-2 text-sm/5 text-pretty break-words text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {[until && `Until ${until}`, account.detail].filter(Boolean).join(" · ")}
    </p>
  {/if}
  <UsageMeters {usage} />
</li>

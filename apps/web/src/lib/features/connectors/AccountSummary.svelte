<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import { connectorAccessSummary, connectorStatus } from "@canopy/domain/format";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatAge, formatEnglishDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ConnectorIcon from "./ConnectorIcon.svelte";

  let {
    account,
    type,
    expanded,
    testing,
    onclick,
    class: className,
  }: {
    account: connectors.ConnectorAccount;
    type: connectors.ConnectorType;
    expanded: boolean;
    testing: boolean;
    onclick: () => void;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
</script>

<button
  type="button"
  aria-label="Edit access for {account.name}, {type.name}"
  aria-describedby="{id}-status {id}-activity"
  aria-expanded={expanded}
  {onclick}
  class={[
    "grid min-h-14 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 rounded-lg py-2 text-left text-base/5 focus-ring hover:bg-zinc-950/3 sm:text-sm/5 @min-[36rem]:grid-cols-[auto_minmax(0,1fr)_minmax(0,9rem)_minmax(0,11rem)] dark:hover:bg-white/4",
    className,
  ]}
>
  <ConnectorIcon type={type.id} class="shrink-0 self-start @min-[36rem]:self-center" />
  <div class="flex min-w-0 items-baseline gap-2 @min-[36rem]:block">
    <p class="min-w-0 flex-1 truncate font-medium" title={account.name}>{account.name}</p>
    <p class="max-w-2/5 truncate text-zinc-500 @min-[36rem]:max-w-full dark:text-zinc-400" title={type.name}>
      {type.name}
    </p>
  </div>
  <div
    id="{id}-status"
    class="col-start-2 flex min-w-0 items-center gap-2 text-sm/5 @min-[36rem]:col-start-auto @min-[36rem]:grid @min-[36rem]:gap-0"
  >
    <p role="status" class="flex min-w-0 items-center gap-1.5">
      <StatusDot
        tone={account.status === "connected" ? "emerald" : account.status === "error" ? "rose" : "amber"}
        active={testing}
      />
      <span class="truncate">{testing ? "Testing…" : connectorStatus(account.status)}</span>
    </p>
    <p class="truncate text-zinc-500 dark:text-zinc-400">This computer</p>
  </div>
  <div
    id="{id}-activity"
    class="col-start-2 flex min-w-0 items-baseline gap-2 text-sm/5 text-zinc-500 @min-[36rem]:col-start-auto @min-[36rem]:block dark:text-zinc-400"
  >
    <p class="min-w-0 flex-1 truncate tabular-nums">
      <time datetime={isoDateTime(account.lastUsedAt)} {@attach tooltip(formatEnglishDateTime(account.lastUsedAt))}>
        <span class="@min-[36rem]:hidden"
          >{account.lastUsedAt ? `Last used ${formatAge(account.lastUsedAt, clock.now)}` : "Not used yet"}</span
        >
        <span class="@max-[36rem]:hidden"
          >{account.lastUsedAt ? `Last used ${formatRelative(account.lastUsedAt, clock.now)}` : "Not used yet"}</span
        >
      </time>
    </p>
    <p class="max-w-3/5 min-w-0 truncate @min-[36rem]:max-w-full" title={connectorAccessSummary(account)}>
      {connectorAccessSummary(account)}
    </p>
  </div>
</button>

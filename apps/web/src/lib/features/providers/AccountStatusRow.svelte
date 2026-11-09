<script lang="ts" module>
  import type { ProviderAccountStatus } from "@canopy/contracts";

  /** False when the harness has nothing to say about the account (Grok, a missing CLI): the row stays empty. */
  export function hasAccountStatus(account: ProviderAccountStatus | undefined): boolean {
    return !!account && (account.state !== "unknown" || !!account.authMethod || !!account.detail);
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { Provider } from "@canopy/contracts";
  import { providerLoginCommand } from "@canopy/domain/provider-accounts";
  import Sensitive from "#lib/shared/ui/Sensitive.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import { providerCall, harnessName } from "./instances.ts";

  let {
    account,
    workerId,
    harness,
    id,
    online,
    os,
    onupdated,
  }: {
    account?: ProviderAccountStatus;
    workerId: string;
    harness: Provider;
    id: string;
    online: boolean;
    os: string;
    onupdated?: () => Promise<void>;
  } = $props();

  let busy = $state(false);
  let failure = $state("");
  let help = $state(false);
  let now = $state(Date.now());
  const expiry = $derived(account?.expiresAt ? timestampDate(account.expiresAt) : undefined);
  const expired = $derived(expiry !== undefined && expiry.getTime() <= now);
  const soon = $derived(expiry !== undefined && !expired && expiry.getTime() - now < 7 * 86_400_000);
  const proxy = $derived(account?.authMethod === "Proxy");
  const warn = $derived(expired || account?.state === "signed_out" || account?.state === "error");
  const signIn = $derived(!proxy && (expired || account?.state === "signed_out"));

  const statusLabel = $derived(
    expired
      ? "Expired"
      : account?.state === "signed_in"
        ? "Signed in"
        : account?.state === "signed_out"
          ? "Not signed in"
          : account?.state === "error"
            ? "Check failed"
            : "",
  );

  // The separator belongs to the item after it, so a wrapped line never ends with a lone dot.
  const sep = "before:mr-1.5 before:text-zinc-400 before:content-['·'_/_''] dark:before:text-zinc-500";

  const login = $derived(
    account
      ? providerLoginCommand(
          harness === Provider.CLAUDE ? "claude" : harness === Provider.CODEX ? "codex" : "grok",
          account,
          os,
        )
      : "",
  );

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);

    return () => clearInterval(timer);
  });

  let previousScope = "";

  $effect(() => {
    const scope = `${workerId}/${harness}/${id}`;

    if (scope !== previousScope) {
      previousScope = scope;
      help = false;
      failure = "";
    }
  });

  async function refresh() {
    busy = true;
    failure = "";

    try {
      const result = await providerCall("refresh", { workerId, harness, id, accountOnly: true }, 75_000);
      failure = result.skipped.length ? "The worker could not refresh this account. Try again." : "";
      await onupdated?.();
    } catch {
      failure = "Could not refresh account status. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

{#if account && hasAccountStatus(account)}
  <div class="grid min-w-0 gap-0.5">
    <div
      class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400"
    >
      {#if proxy}
        <span class="text-zinc-950 dark:text-white">Proxy</span>
        {#if account.proxyName}<span class={[sep, "min-w-0 break-words"]}>{account.proxyName}</span>{/if}
        {#if account.state !== "signed_in"}<span class={[sep, "text-amber-700 dark:text-amber-400"]}>Needs setup</span
          >{/if}
      {:else}
        {#if statusLabel}<span class={warn ? "text-amber-700 dark:text-amber-400" : "text-zinc-950 dark:text-white"}
            >{statusLabel}</span
          >{/if}
        {#if account.authMethod}<span class={statusLabel && sep}>{account.authMethod}</span>{/if}
        {#if account.plan}<span class={[sep, "capitalize"]}>{account.plan}</span>{/if}
        {#if account.organization}<span class={[sep, "min-w-0 break-words"]}>{account.organization}</span>{/if}
        {#if account.email}<span class={[sep, "flex min-w-0 items-baseline"]}
            ><Sensitive value={account.email} label="Account email" /></span
          >{/if}
        {#if expiry && !expired}<span class={[sep, soon && "text-amber-700 dark:text-amber-400"]}
            >expires {soon
              ? formatRelative(account.expiresAt, now)
              : expiry.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span
          >{/if}
      {/if}
      {#if account.checkedAt}<span class={[sep, "text-zinc-500 dark:text-zinc-400"]}
          >checked {formatRelative(account.checkedAt, now)}</span
        >{/if}
      {#if harness !== Provider.GROK}
        <IconButton
          icon="arrow-path"
          size="sm"
          loading={busy}
          disabled={!online}
          label={online ? `Refresh ${harnessName(harness)} account status` : "Worker is offline"}
          onclick={refresh}
        />
      {/if}
      {#if signIn}
        <Popover bind:open={help} label="Sign in" placement="bottom-start" class="w-[min(20rem,calc(100vw-1rem))] p-3">
          {#snippet trigger(props)}<Button {...props} variant="ghost" size="sm">Sign in</Button>{/snippet}
          <p class="text-sm/6 text-zinc-600 dark:text-zinc-400">
            {login
              ? `Run this on the worker${os === "win32" ? " in PowerShell" : ""}, then refresh.`
              : "Refresh account status to get this instance’s sign-in command. Update the worker if it stays unavailable."}
          </p>
          {#if login}
            <div
              class="mt-1 flex min-w-0 items-center gap-1 rounded-md bg-zinc-950/5 py-0.5 pr-0.5 pl-2 dark:bg-white/5"
            >
              <code class="min-w-0 flex-1 truncate font-mono text-sm/6 text-zinc-950 dark:text-white">{login}</code>
              <CopyButton text={login} label="Copy command" />
            </div>
          {/if}
        </Popover>
      {/if}
    </div>
    {#if account.configDir}<p
        class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
      >
        Config directory <Sensitive value={account.configDir} label="Configuration directory" />
      </p>{/if}
    {#if account.detail}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{account.detail}</p>{/if}
    {#if failure}<p role="alert" class="text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400">{failure}</p>{/if}
  </div>
{/if}

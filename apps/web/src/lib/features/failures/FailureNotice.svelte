<script lang="ts">
  import { safeFailureDetail } from "@canopy/domain";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { failurePresentation } from "./presentation.ts";

  let {
    message,
    code = "",
    source = "",
    classification = "",
    authHint = "",
    proxy = false,
    providerHref = "/settings/providers",
    onretry,
    onchangemodel,
    onchangeworker,
    signInLabel = "Sign in",
    retrying = false,
    retryDisabled = false,
    heading = "Could not finish this turn",
  }: {
    message: string;
    code?: string | undefined;
    source?: string | undefined;
    classification?: string;
    authHint?: string;
    proxy?: boolean;
    providerHref?: string;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    onchangeworker?: (() => void) | undefined;
    signInLabel?: string;
    retrying?: boolean;
    retryDisabled?: boolean;
    heading?: string;
  } = $props();

  const failure = $derived(failurePresentation(message, classification || code, proxy));

  const details = $derived(
    safeFailureDetail([source && `Source: ${source}`, code && `Code: ${code}`, message].filter(Boolean).join("\n")),
  );
</script>

<div class="grid min-w-0 gap-2 text-base/6 sm:text-sm/6">
  <p class="font-medium text-rose-700 dark:text-rose-400">{heading}</p>
  <p class="text-pretty text-zinc-600 dark:text-zinc-400">{failure.explanation}</p>
  {#if failure.kind === "auth_required" && !proxy && authHint}
    <p class="text-zinc-600 dark:text-zinc-400">{authHint}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2">
    {#if failure.model && onchangemodel}<Button size="sm" onclick={onchangemodel}>Change model</Button>{/if}
    {#if failure.settings}
      <ButtonLink size="sm" variant="ghost" href={providerHref}
        >{failure.kind === "auth_required" && !proxy ? signInLabel : "Open provider settings"}</ButtonLink
      >
    {/if}
    {#if failure.proxy}<ButtonLink size="sm" variant="ghost" href="/settings/proxies"
        >Check proxy (Test connection)</ButtonLink
      >{/if}
    {#if onretry}<Button size="sm" loading={retrying} disabled={retryDisabled} onclick={onretry}>Retry</Button>{/if}
    {#if onchangeworker}<Button size="sm" variant="ghost" onclick={onchangeworker}>Pick another worker (Runs on)</Button
      >{/if}
  </div>
  <Disclosure class="min-w-0 text-zinc-500 dark:text-zinc-400">
    {#snippet summary()}Show details{/snippet}
    <div class="flex min-w-0 items-start gap-2 py-2">
      <pre class="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap select-text">{details}</pre>
      <CopyButton text={details} label="Copy error details" />
    </div>
  </Disclosure>
</div>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, ProviderProfileKind } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import FailureNotice from "#lib/features/failures/FailureNotice.svelte";
  import { botList } from "../bot-list.svelte.ts";
  import type { ChatErrorView, ParticipantView } from "@canopy/domain/bot-chat";

  let {
    error,
    sender,
    retrying = false,
    onretry,
    onchangemodel,
    onchangeworker,
    class: className,
  }: {
    error: ChatErrorView;
    sender: ParticipantView | undefined;
    retrying?: boolean;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    onchangeworker?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const config = $derived(botList.list.find((bot) => bot.id === error.botId)?.configuration);
  const overview = useOverview();
  const worker = $derived(overview.worker(config?.workerId ?? ""));

  const instance = $derived(
    worker?.providerInstances.find((i) => i.harness === config?.provider && i.id === config.providerInstance),
  );

  const proxy = $derived(instance?.kind === ProviderProfileKind.CLIPROXYAPI);

  const providerHref = $derived(
    config
      ? `/settings/providers?instance=${Provider[config.provider]}:${encodeURIComponent(config.providerInstance)}${config.workerId ? `&worker=${encodeURIComponent(config.workerId)}` : ""}`
      : "/settings/providers",
  );
</script>

<div class={["min-w-0 pl-9", className]}>
  <FailureNotice
    heading={`${sender?.name ?? "The bot"} couldn't reply`}
    message={error.detail}
    code={error.code}
    source={error.source}
    {proxy}
    signInLabel="Sign in on that worker"
    authHint={`Sign in to ${config ? Provider[config.provider] : "the provider"} on ${worker?.name ?? "the bot's worker"} using this instance's CLI home, then retry.`}
    {providerHref}
    {retrying}
    onretry={error.retryable ? onretry : undefined}
    {onchangemodel}
    {onchangeworker}
  />
</div>

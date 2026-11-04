<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider } from "@canopy/contracts";
  import FailureNotice from "#lib/features/failures/FailureNotice.svelte";
  import { botList } from "../bot-list.svelte.ts";
  import type { ChatErrorView, ParticipantView } from "../model.ts";

  let {
    error,
    sender,
    retrying = false,
    onretry,
    onchangemodel,
    class: className,
  }: {
    error: ChatErrorView;
    sender: ParticipantView | undefined;
    retrying?: boolean;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const config = $derived(botList.list.find((bot) => bot.id === error.botId)?.configuration);

  const providerHref = $derived(
    config
      ? `/settings/providers?instance=${Provider[config.provider]}:${encodeURIComponent(config.providerInstance)}`
      : "/settings/providers",
  );
</script>

<div class={["min-w-0 pl-9", className]}>
  <FailureNotice
    heading={`${sender?.name ?? "The bot"} couldn't reply`}
    message={error.detail}
    code={error.code}
    source={error.source}
    proxy
    {providerHref}
    {retrying}
    onretry={error.retryable ? onretry : undefined}
    {onchangemodel}
  />
</div>

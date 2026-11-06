<script lang="ts">
  import { goto } from "$app/navigation";
  import ChatView from "#lib/features/bots/components/ChatView.svelte";
  import { botParticipant, exchangeEntries } from "#lib/features/bots/live.ts";
  import type { BotView, ConversationView } from "@canopy/domain/bot-chat";
  import type { PageProps } from "./$types";
  import { watchExchange } from "#lib/features/bots/exchange.svelte.ts";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";

  /** Two bots talking to each other ("Grok Bot ⇄ FIXme CRM"): you read along and close it. */
  let { data, params }: PageProps = $props();
  const history = watchExchange(() => params.exchangeId);

  $effect(() => botList.use());

  const messages = $derived(history.snapshot?.messages ?? data.exchange?.messages ?? []);

  const directory = $derived(
    [
      ...new Map(
        [...data.bots, ...botList.list, ...(history.snapshot?.participants ?? [])].map((bot) => [bot.id, bot]),
      ).values(),
    ].map(botParticipant),
  );

  const pair = $derived.by((): BotView[] => {
    const ids = [
      ...new Set([params.botId, ...messages.map((m) => m.senderId), ...messages.map((m) => m.recipientId)]),
    ].filter((id) => !["user", "system", "self"].includes(id));

    return ids.slice(0, 2).map(
      (id) =>
        directory.find((b) => b.id === id) ?? {
          id,
          kind: "bot",
          name: "Deleted bot",
          color: "#71717a",
          shape: "round",
        },
    );
  });

  const conversation = $derived<ConversationView>({
    id: params.exchangeId,
    kind: "watch",
    bots: pair,
    unread: 0,
    pinned: false,
  });

  const entries = $derived(exchangeEntries(messages));
  const close = () => goto(`/bots/${params.botId}`);
</script>

<svelte:head><title>{pair.map((b) => b.name).join(" ⇄ ")} · Canopy</title></svelte:head>
<svelte:window
  onkeydown={(event) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !(event.target instanceof Element && event.target.closest("[popover], dialog"))
    )
      void close();
  }}
/>
<ChatView
  {conversation}
  {entries}
  loading={!history.snapshot && !data.exchange}
  syncing={history.syncing}
  me={{ id: "me", kind: "user", name: "You" }}
  {directory}
  subtitle="Bot conversation"
  onsend={() => {}}
  onclose={close}
  class="h-full"
>
  {#snippet notice()}{#if history.error}<Alert tone="warning" banner title="Sync interrupted">{history.error}</Alert
      >{/if}{/snippet}
</ChatView>

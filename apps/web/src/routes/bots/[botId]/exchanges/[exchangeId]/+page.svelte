<script lang="ts">
  import { goto } from "$app/navigation";
  import ChatView from "#lib/features/bots/components/ChatView.svelte";
  import { botParticipant, exchangeEntries } from "#lib/features/bots/live.ts";
  import type { BotView, ConversationView } from "#lib/features/bots/model.ts";
  import type { PageProps } from "./$types";

  /** Two bots talking to each other ("Grok Bot ⇄ FIXme CRM"): you read along and close it. */
  let { data, params }: PageProps = $props();
  const directory = $derived(data.bots.map(botParticipant));
  const pair = $derived.by((): BotView[] => {
    const ids = [...new Set([params.botId, ...data.messages.map((m) => m.senderId), ...data.messages.map((m) => m.recipientId)])].filter((id) => directory.some((b) => b.id === id));
    return ids.slice(0, 2).map((id) => directory.find((b) => b.id === id)!);
  });
  const conversation = $derived<ConversationView>({ id: params.exchangeId, kind: "watch", bots: pair, unread: 0, pinned: false });
  const entries = $derived(exchangeEntries(data.messages));
  const close = () => goto(`/bots/${params.botId}`);
</script>

<svelte:head><title>{pair.map((b) => b.name).join(" ⇄ ")} · Canopy</title></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest("[popover], dialog"))) void close(); }} />
<ChatView {conversation} {entries} me={{ id: "me", kind: "user", name: "You" }} {directory} subtitle="Bot conversation" onsend={() => {}} onclose={close} class="h-full" />

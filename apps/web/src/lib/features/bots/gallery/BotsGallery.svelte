<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import type { ChatEntry, ChatMessageView, ConversationView } from "@canopy/domain/bot-chat";
  import AvatarStack from "../components/AvatarStack.svelte";
  import BotAvatar, { type AvatarSize } from "../components/BotAvatar.svelte";
  import BotComposer from "../components/BotComposer.svelte";
  import BotsNav from "../components/BotsNav.svelte";
  import BotsSectionEmpty from "../components/BotsSectionEmpty.svelte";
  import ChatDateLine from "../components/ChatDateLine.svelte";
  import ChatEventLine from "../components/ChatEventLine.svelte";
  import ChatView from "../components/ChatView.svelte";
  import ConversationHeader from "../components/ConversationHeader.svelte";
  import LinkChip from "../components/LinkChip.svelte";
  import QuestionCard from "../components/QuestionCard.svelte";
  import UnreadDivider from "../components/UnreadDivider.svelte";
  import WatchBar from "../components/WatchBar.svelte";
  import { bots, conversations, directEntries, groupEntries, me, pictureBot, watchEntries } from "./fixtures.ts";
  import GallerySection from "./GallerySection.svelte";
  import ApprovalExpiryGallery from "./ApprovalExpiryGallery.svelte";
  import ApprovalCountdownGallery from "./ApprovalCountdownGallery.svelte";
  import WizardGallery from "./WizardGallery.svelte";
  import Segmented from "./Segmented.svelte";
  import BehaviourGallery from "./BehaviourGallery.svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * Dev-only gallery of the Bots components with made-up data (`/dev/bots`, absent from production
   * builds). Pins, read state, sending and answering work in memory so the interactions can be tried.
   */
  let { class: className }: { class?: ClassValue } = $props();
  let list = $state<ConversationView[]>(structuredClone(conversations));
  let query = $state("");
  let selectedId = $state("c-canopy");
  let log = $state("Interactions show up here.");

  function togglePin(conversation: ConversationView) {
    const nextOrder = Math.max(-1, ...list.filter((c) => c.pinned).map((c) => c.pinOrder ?? 0)) + 1;
    list = list.map((c) =>
      c.id === conversation.id ? { ...c, pinned: !c.pinned, pinOrder: c.pinned ? undefined : nextOrder } : c,
    );
    log = `${conversation.pinned ? "Unpinned" : "Pinned"} ${conversation.title ?? conversation.bots.map((b) => b.name).join(" ⇄ ")}.`;
  }

  function markRead(conversation: ConversationView) {
    list = list.map((c) => (c.id === conversation.id ? { ...c, unread: 0 } : c));
    log = "Marked as read.";
  }

  type ChatKey = "direct" | "group" | "watch";

  let chat = $state<ChatKey>("direct");
  let frame = $state<"desktop" | "mobile">("desktop");

  const chats: Record<ChatKey, { conversation: ConversationView; firstUnreadId?: string }> = {
    direct: { conversation: conversations.find((c) => c.id === "c-canopy")!, firstUnreadId: "d10" },
    group: { conversation: conversations.find((c) => c.id === "c-launch")!, firstUnreadId: "g8" },
    watch: { conversation: conversations.find((c) => c.id === "c-watch")! },
  };

  let entries = $state<Record<ChatKey, ChatEntry[]>>({
    direct: structuredClone(directEntries),
    group: structuredClone(groupEntries),
    watch: structuredClone(watchEntries),
  });

  let answering = $state<Record<string, string>>({});
  let sending = $state(false);

  function send(text: string) {
    const key = chat;
    const id = `local-${Date.now()}`;
    entries[key] = [
      ...entries[key],
      { kind: "message", message: { id, senderId: me.id, at: new Date(), text, delivery: "sending" } },
    ];
    sending = true;
    setTimeout(() => {
      entries[key] = entries[key].map((e) =>
        e.kind === "message" && e.message.id === id
          ? { kind: "message", message: { ...e.message, delivery: undefined } }
          : e,
      );
      sending = false;
    }, 800);
  }

  function answer(questionId: string, optionId: string) {
    const key = chat;
    answering = { ...answering, [questionId]: optionId };
    setTimeout(() => {
      entries[key] = entries[key].map((e) =>
        e.kind === "question" && e.question.id === questionId
          ? { kind: "question", question: { ...e.question, answer: { optionId, at: new Date() } } }
          : e,
      );
      const { [questionId]: _, ...rest } = answering;
      answering = rest;
    }, 900);
  }

  const react = (message: ChatMessageView) => (log = `React to “${message.text.slice(0, 40)}”.`);

  const mascotIds = Array.from(
    { length: 21 },
    (_, i) => `bot-${["canopy", "sync", "release", "docs", "triage", "standup", "infra"][i % 7]}-${Math.floor(i / 7)}`,
  );

  const sizes: AvatarSize[] = ["xs", "sm", "md", "lg", "xl"];
  const question = directEntries.find((e) => e.kind === "question")!;
  const answered = groupEntries.find((e) => e.kind === "question")!;
  let galleryAnswer = $state<string>();
  let composerValue = $state("");
</script>

<svelte:head><title>Bots gallery · {applicationName}</title></svelte:head>

<div class={["flex h-full flex-col", className]}>
  <TopBar><Crumb current={false}>Dev</Crumb><Crumb>Bots gallery</Crumb></TopBar>
  <div class="min-h-0 flex-1 scroll-stable overflow-y-auto">
    <div class="mx-auto grid max-w-6xl gap-10 px-4 pt-4 pb-16 sm:px-6">
      <div class="grid gap-2">
        <h1 class="text-2xl font-semibold tracking-tight text-balance">Bots components</h1>
        <p class="max-w-[65ch] text-base/7 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Presentational pieces for bots in the gateway, with made-up data. This page exists only in development builds.
        </p>
        <p class="flex items-center gap-2 text-sm/6 text-zinc-500 dark:text-zinc-400" role="status">
          <Icon name="information-circle" class="fill-zinc-400 dark:fill-zinc-500" />{log}
        </p>
      </div>

      <BehaviourGallery />
      <WizardGallery />

      <GallerySection
        title="Avatars"
        description="Mascot shape, colour and eyes come from the bot id. A picture replaces the mascot; you get initials. Badges mark pinned and online."
      >
        <div class="flex flex-wrap items-end gap-4">
          {#each sizes as size (size)}<BotAvatar participant={bots.canopy} {size} />{/each}
          <BotAvatar participant={pictureBot} size="lg" />
          <BotAvatar participant={me} size="lg" />
          <BotAvatar participant={bots.sync} size="lg" badge="pinned" />
          <BotAvatar participant={bots.docs} size="lg" badge="online" />
          <BotAvatar participant={bots.release} size="md" badge="pinned" />
        </div>
        <div class="flex flex-wrap gap-3">
          {#each mascotIds as id (id)}<BotAvatar participant={{ id, kind: "bot", name: id }} size="md" />{/each}
        </div>
        <div class="flex flex-wrap items-center gap-6">
          <AvatarStack participants={[bots.canopy, bots.sync]} layout="square" />
          <AvatarStack participants={[bots.canopy, bots.sync, bots.docs]} layout="square" size="lg" />
          <AvatarStack participants={[bots.canopy, bots.sync, bots.docs]} />
          <AvatarStack participants={Object.values(bots)} />
        </div>
      </GallerySection>

      <GallerySection
        title="Sidebar: Bots section"
        description="Pinned chats on top as large avatars with a star; then 1:1, group and watched chats by latest message. Pin or unpin from a row's “…”, or right-click, Shift+F10 or long-press a pinned avatar. Search lists everything as rows."
      >
        <div class="flex flex-wrap items-start gap-6">
          <div
            class="flex h-[36rem] w-72 flex-col rounded-xl bg-zinc-50 ring-1 ring-zinc-950/5 dark:bg-zinc-950 dark:ring-white/10"
          >
            <div class="p-3">
              <Input
                type="search"
                name="gallery-q"
                aria-label="Search bots"
                placeholder="Search bots"
                autocomplete="off"
                bind:value={query}
              />
            </div>
            <div class="min-h-0 flex-1 scroll-stable overflow-y-auto px-2 pb-3">
              <BotsNav
                conversations={list}
                hrefOf={(c) => `#${c.id}`}
                currentId={selectedId}
                {query}
                onTogglePin={togglePin}
                onMarkRead={markRead}
              />
            </div>
          </div>
          <div class="grid w-72 gap-2">
            <p class="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Production today (no bots yet)</p>
            <div class="rounded-xl bg-zinc-50 p-2 ring-1 ring-zinc-950/5 dark:bg-zinc-950 dark:ring-white/10">
              <BotsSectionEmpty />
            </div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          {#each list as conversation (conversation.id)}
            <Button
              size="sm"
              variant={selectedId === conversation.id ? "primary" : "secondary"}
              aria-pressed={selectedId === conversation.id}
              onclick={() => (selectedId = conversation.id)}
            >
              Select {conversation.id}
            </Button>
          {/each}
        </div>
      </GallerySection>

      <GallerySection title="Conversation headers" description="1:1, group, and a watched bot ⇄ bot chat.">
        <div class="grid gap-2 rounded-xl ring-1 ring-zinc-950/5 dark:ring-white/10">
          <ConversationHeader conversation={chats.direct.conversation} titlebar={false} />
          <ConversationHeader conversation={chats.group.conversation} titlebar={false} />
          <ConversationHeader conversation={chats.watch.conversation} titlebar={false} />
        </div>
      </GallerySection>

      <GallerySection title="Timeline pieces">
        <div class="grid max-w-xl gap-4">
          <ChatDateLine at={new Date()} />
          <UnreadDivider />
          {#each directEntries.filter((e) => e.kind === "event") as entry (entry.event.id)}
            <ChatEventLine event={entry.event} />
          {/each}
          <div class="flex flex-wrap gap-2">
            <LinkChip
              link={{
                url: "https://github.com/example/canopy/pull/443",
                title: "Merge after CI",
                kind: "pull_request",
                subtitle: "canopy#443",
              }}
            />
            <LinkChip
              link={{
                url: "https://github.com/example/canopy/issues/12",
                title: "Composer loses focus",
                kind: "issue",
                subtitle: "canopy#12",
              }}
            />
            <LinkChip
              link={{ url: "https://github.com/example/canopy/commit/1aa4d69", title: "1aa4d69", kind: "commit" }}
            />
            <LinkChip link={{ url: "https://svelte.dev/docs/kit", title: "SvelteKit docs", kind: "web" }} />
            <LinkChip
              link={{ url: "javascript:alert(1)", title: "Unsafe link stays text", kind: "web", subtitle: "blocked" }}
            />
          </div>
        </div>
      </GallerySection>

      <GallerySection
        title="Question card"
        description="Open (click, Enter or the letter key), sending, answered, and read-only."
      >
        <div class="flex flex-wrap items-start gap-4">
          {#if question.kind === "question"}
            <QuestionCard
              question={galleryAnswer
                ? { ...question.question, answer: { optionId: galleryAnswer, at: new Date() } }
                : question.question}
              onanswer={(id) => (galleryAnswer = id)}
            />
            <QuestionCard question={question.question} answering="now" onanswer={() => {}} />
            <QuestionCard question={question.question} />
          {/if}
          {#if answered.kind === "question"}<QuestionCard question={answered.question} onanswer={() => {}} />{/if}
        </div>
      </GallerySection>

      <ApprovalExpiryGallery />
      <ApprovalCountdownGallery />

      <GallerySection
        title="Composer and read-only bar"
        description="Attachments and voice are not built yet, so “+” and the mic explain that. Typing turns the mic into send."
      >
        <div class="grid max-w-xl gap-4">
          <BotComposer
            botId="gallery"
            quoteKey="bot:gallery"
            bind:value={composerValue}
            onsend={(text) => (log = `Sent “${text}”.`)}
          />
          <BotComposer
            botId="gallery"
            quoteKey="bot:gallery-sending"
            value="Sending this one…"
            sending
            onsend={() => {}}
          />
          <BotComposer
            botId="gallery"
            quoteKey="bot:gallery-disabled"
            disabled
            disabledReason="Canopy Bot is unavailable right now"
            onsend={() => {}}
          />
          <BotComposer
            botId="gallery"
            quoteKey="bot:gallery-attach"
            onsend={() => {}}
            onattach={() => (log = "Attach.")}
          />
          <WatchBar bots={chats.watch.conversation.bots} onclose={() => (log = "Close chat.")} />
        </div>
      </GallerySection>

      <GallerySection
        title="Chats"
        description="Full chats with fixture data. Sending and answering resolve after a moment; actions write to the line at the top."
      >
        <div class="flex flex-wrap gap-3">
          <Segmented
            label="Chat"
            bind:value={chat}
            options={[
              { value: "direct", label: "1:1" },
              { value: "group", label: "Group" },
              { value: "watch", label: "Bot ⇄ Bot" },
            ]}
          />
          <Segmented
            label="Width"
            bind:value={frame}
            options={[
              { value: "desktop", label: "Desktop" },
              { value: "mobile", label: "Mobile" },
            ]}
          />
        </div>
        <div
          class={[
            "h-[46rem] overflow-hidden rounded-xl bg-white ring-1 ring-zinc-950/10 dark:bg-black dark:ring-white/10",
            frame === "mobile" ? "w-full max-w-[390px]" : "w-full",
          ]}
        >
          {#key chat}
            <ChatView
              conversation={chats[chat].conversation}
              entries={entries[chat]}
              {me}
              firstUnreadId={chats[chat].firstUnreadId}
              {answering}
              {sending}
              onsend={send}
              onanswer={answer}
              onreact={react}
              onclose={() => (log = "Close chat: you would stop watching.")}
            />
          {/key}
        </div>
      </GallerySection>
    </div>
  </div>
</div>

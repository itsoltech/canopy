<script lang="ts" module>
  import type { IconName } from "#lib/shared/ui/icons.ts";

  /** A line above the message: what happens to it (queued, steering into the turn, steered). */
  export interface MessageNote {
    readonly text: string;
    /** "spinner" while it is on its way. */
    readonly icon: IconName | "spinner";
    readonly tone?: "neutral" | "amber";
  }
</script>

<script lang="ts">
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import type { Snippet } from "svelte";
  import { MentionKind, type UserMessage, type ui } from "@canopy/contracts";
  import { hasPlatformNote } from "@canopy/domain";
  import AttachmentChip from "#lib/features/attachments/AttachmentChip.svelte";
  import MessageAttachments from "#lib/features/attachments/MessageAttachments.svelte";
  import MessageQuotes from "#lib/features/quotes/MessageQuotes.svelte";
  import { withoutPlatformNote } from "#lib/features/mentions/editor.ts";
  import MentionChip from "#lib/features/mentions/MentionChip.svelte";
  import { withoutIds } from "#lib/shared/humanize.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import AgentSenderLabel from "../AgentSenderLabel.svelte";
  import AgentMessageBubble from "./AgentMessageBubble.svelte";

  /**
   * A message you (or another agent, over the agent bus) wrote: the input of a turn, or one steered into
   * it while it ran. `note` says what happens to it; `pending` dims it until it reaches the agent. `files`: the
   * message's attachments (badges where the user placed them, the rest as images and file chips under the text); `quotes`: passages of the thread it quotes, in
   * the bubble above the text; `details` goes inside the bubble (e.g. the full text the agent received with the
   * platform note). `sender`: the thread whose agent wrote it (send_message), named like a turn from an agent; an
   * agent's message folds to its first line (AgentMessageBubble).
   */
  let {
    message,
    note,
    pending = false,
    files = [],
    quotes = [],
    details,
    sender,
  }: {
    message: Pick<UserMessage, "text" | "authorAgentId" | "attachments"> & { mentions?: UserMessage["mentions"] };
    note?: MessageNote | undefined;
    pending?: boolean;
    files?: readonly ui.Attachment[];
    quotes?: readonly ui.Quote[];
    details?: Snippet | undefined;
    sender?: ui.AgentSender | undefined;
  } = $props();

  const fromAgent = $derived(Boolean(message.authorAgentId || sender));

  // With mentions the chips render; the platform's note in front (threads, files) is the agent's, not shown here.
  const shown = $derived(
    message.mentions?.length ? withoutPlatformNote({ text: message.text, mentions: [...message.mentions] }) : undefined,
  );

  const body = $derived(shown?.text ?? (hasPlatformNote(message.text) ? withoutIds(message.text) : message.text));

  // Files placed in the text show there; only the others go under the bubble.
  const placed = $derived(
    new Set((shown?.mentions ?? []).flatMap((m) => (m.kind === MentionKind.ATTACHMENT ? [m.name] : []))),
  );

  const loose = $derived(files.filter((f) => !placed.has(f.id)));
</script>

<div class="flex flex-col items-end gap-1">
  {#if fromAgent || note}
    <p
      class={[
        "flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-sm/5 sm:text-xs/5",
        note?.tone === "amber"
          ? "text-amber-700 dark:text-amber-400"
          : fromAgent
            ? "text-violet-700 dark:text-violet-400"
            : "text-zinc-500 dark:text-zinc-400",
      ]}
    >
      <!-- A steer's note changes as it travels (sending, accepted, delivered): each state swaps in. -->
      {#key note?.text}
        <span class="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1" in:swap>
          {#if sender}
            <AgentSenderLabel
              verb="Message from"
              threadId={sender.threadId}
              {sender}
              leading={note || !sender.botId ? noteIcon : undefined}
              trailing={note ? deliveryNote : undefined}
            />
          {:else}
            {@render noteIcon()}
            <span class="min-w-0">{[fromAgent && "From an agent", note?.text].filter(Boolean).join(" · ")}</span>
          {/if}
        </span>
      {/key}
    </p>
  {/if}
  {#if loose.length > 0}
    <MessageAttachments attachments={loose} class={[pending && "opacity-70"]} />
  {/if}
  {#if fromAgent && (message.text.trim() || details || quotes.length > 0)}
    <AgentMessageBubble
      text={body.trim() || quotes[0]?.text || ""}
      rich={quotes.length > 0 || Boolean(details)}
      class={[pending && "opacity-70"]}
    >
      {@render content()}
    </AgentMessageBubble>
  {:else if message.text.trim() || details || quotes.length > 0}
    <div
      class={[
        "max-w-[min(85%,42rem)] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-base/6 break-words text-zinc-950 sm:text-sm/6 dark:bg-white/10 dark:text-white",
        pending && "opacity-70",
      ]}
    >
      {@render content()}
    </div>
  {/if}
  {#if files.length === 0 && message.attachments.length > 0}
    <p class="flex items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <Icon name="photo" class="size-3.5" />{message.attachments.length}
      {message.attachments.length === 1 ? "attachment" : "attachments"}
    </p>
  {/if}
</div>

{#snippet content()}
  {#if quotes.length > 0}<MessageQuotes {quotes} class={[message.text.trim() && "mb-2"]} />{/if}
  {#if message.text.trim()}
    <Markdown
      text={body}
      breaks
      elements={shown && { ranges: shown.mentions, render: chip }}
      class="text-inherit dark:text-inherit"
    />
  {/if}
  {@render details?.()}
{/snippet}

{#snippet noteIcon()}
  {#if note?.icon === "spinner"}<Spinner class="size-3.5 shrink-0" />{:else}<Icon
      name={note?.icon ?? "sparkles"}
      class="size-3.5 shrink-0"
    />{/if}
{/snippet}

{#snippet deliveryNote()}
  <span class="max-w-[calc(100%-2rem)] shrink-0 truncate whitespace-nowrap" title={note?.text}>· {note?.text}</span>
{/snippet}

{#snippet chip(index: number)}
  {@const mention = shown?.mentions[index]}
  {#if mention?.kind === MentionKind.ATTACHMENT}<AttachmentChip
      {mention}
      file={files.find((f) => f.id === mention.name)}
    />{:else if mention}<MentionChip {mention} />{/if}
{/snippet}

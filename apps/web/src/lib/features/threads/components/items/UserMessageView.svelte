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
  import type { Snippet } from "svelte";
  import type { UserMessage, ui } from "@open-agents/contracts";
  import MessageAttachments from "#lib/features/attachments/MessageAttachments.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";

  /**
   * A message you (or another agent, over the agent bus) wrote: the input of a turn, or one steered into
   * it while it ran. `note` says what happens to it; `pending` dims it until it reaches the agent. `files`: the
   * message's attachments (images and file chips under the text); `details` goes inside the bubble (e.g. the full
   * text the agent received with the platform note).
   */
  let {
    message,
    note,
    pending = false,
    files = [],
    details,
  }: {
    message: Pick<UserMessage, "text" | "authorAgentId" | "attachments">;
    note?: MessageNote | undefined;
    pending?: boolean;
    files?: readonly ui.Attachment[];
    details?: Snippet | undefined;
  } = $props();
  const fromAgent = $derived(Boolean(message.authorAgentId));
</script>

<div class="flex flex-col items-end gap-1">
  {#if fromAgent || note}
    <p
      class={[
        "flex max-w-full items-center gap-1 text-sm/5 sm:text-xs/5",
        note?.tone === "amber" ? "text-amber-700 dark:text-amber-400" : fromAgent ? "text-violet-700 dark:text-violet-400" : "text-zinc-500 dark:text-zinc-400",
      ]}
    >
      <!-- A steer's note changes as it travels (sending, accepted, delivered): each state swaps in. -->
      {#key note?.text}
        <span class="flex min-w-0 items-center gap-1" in:swap>
          {#if note?.icon === "spinner"}<Spinner class="size-3.5" />{:else}<Icon name={note?.icon ?? "sparkles"} class="size-3.5" />{/if}
          <span class="min-w-0">{[fromAgent && "From an agent", note?.text].filter(Boolean).join(" · ")}</span>
        </span>
      {/key}
    </p>
  {/if}
  {#if files.length > 0}
    <MessageAttachments attachments={files} class={[pending && "opacity-70"]} />
  {/if}
  {#if message.text.trim() || details}
    <div
      class={[
        "max-w-[min(85%,42rem)] rounded-2xl rounded-br-md px-4 py-2.5 text-base/6 break-words sm:text-sm/6",
        fromAgent ? "bg-violet-50 text-violet-950 ring-1 ring-violet-600/10 ring-inset dark:bg-violet-400/10 dark:text-violet-50 dark:ring-violet-400/20" : "bg-zinc-100 text-zinc-950 dark:bg-white/10 dark:text-white",
        pending && "opacity-70",
      ]}
    >
      {#if message.text.trim()}<p class="whitespace-pre-wrap">{message.text}</p>{/if}
      {@render details?.()}
    </div>
  {/if}
  {#if files.length === 0 && message.attachments.length > 0}
    <p class="flex items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <Icon name="photo" class="size-3.5" />{message.attachments.length} {message.attachments.length === 1 ? "attachment" : "attachments"}
    </p>
  {/if}
</div>

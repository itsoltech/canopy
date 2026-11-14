<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatDateTime, formatTime, isoDateTime } from "#lib/shared/format.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { turnReveal } from "../turn-reveal.svelte.ts";
  import MessageActionRow from "./MessageActionRow.svelte";
  import RewindButton from "./RewindButton.svelte";

  let { turn }: { turn: ui.Turn } = $props();
  const directory = useThreadDirectory();
  const at = $derived(turn.startedAt ?? turn.queuedAt);

  turnReveal.listen();
</script>

<div data-shown={turnReveal.shows(turn.id) || undefined}>
  <MessageActionRow class="justify-end">
    {#if directory.canRewind && !turn.rewindId}<RewindButton threadId={directory.currentId} turnId={turn.id} />{/if}
    <CopyButton text={turn.messageText || turn.inputText} label="Copy message" />
    {#if at}<time
        class="shrink-0 pl-1.5 text-zinc-500 tabular-nums dark:text-zinc-400"
        datetime={isoDateTime(at)}
        title={formatDateTime(at)}>{formatTime(at)}</time
      >{/if}
  </MessageActionRow>
</div>

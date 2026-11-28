<script lang="ts">
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { useThreadDirectory } from "../../thread-directory.ts";

  let { text, pending = false }: { text: string; pending?: boolean } = $props();
  const directory = useThreadDirectory();
  const drafts = useQuoteDrafts();

  function cite() {
    const added = drafts.add(directory.currentId, {
      text,
      // Received inputs have no output item to reveal; the passage still names its receiving thread.
      source: { itemId: "", threadId: directory.currentId, kind: "agent_message_markdown", language: "" },
    });

    if (!added) toast("A message can carry up to 20 quotes", { tone: "error" });
  }
</script>

{#if text.trim()}
  <div class={["flex items-center gap-1", pending && "invisible"]} inert={pending} data-quote-skip>
    <CopyButton {text} label="Copy message" />
    {#if !directory.readOnly && directory.currentId}
      <IconButton icon="chat-bubble-left-right" label="Quote message" size="sm" onclick={cite} />
    {/if}
  </div>
{/if}

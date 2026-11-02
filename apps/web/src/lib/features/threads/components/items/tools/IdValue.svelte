<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useThreadDirectory } from "../../../thread-directory.ts";
  import ThreadLink from "../ThreadLink.svelte";

  /**
   * An id in a tool's input or result. A thread the page knows is a link with its title and status;
   * any other id stays out of sight: a small "ID" chip whose tooltip shows it and whose press copies it.
   */
  let { id }: { id: string } = $props();
  const directory = useThreadDirectory();
  const thread = $derived(directory.thread(id));
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      toast("Copying is not allowed here", { tone: "error" });
      return;
    }
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

{#if thread || id === directory.currentId}
  <ThreadLink threadId={id} fallback="This thread" />
{:else}
  <button
    type="button"
    class="inline-flex items-center gap-1 rounded-md py-0.5 pr-1.5 pl-1 align-middle font-mono text-zinc-500 ring-1 ring-zinc-950/10 ring-inset hover:bg-zinc-950/5 hover:text-zinc-700 focus-ring dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-white/5 dark:hover:text-zinc-200"
    aria-label={copied ? "Copied" : `Copy ID ${id}`}
    onclick={copy}
    {@attach tooltip(copied ? "Copied" : id)}
  >
    <Icon name={copied ? "check" : "document-duplicate"} class="size-3.5 fill-current" />ID
  </button>
{/if}

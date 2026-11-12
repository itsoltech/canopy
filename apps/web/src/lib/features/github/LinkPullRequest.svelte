<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PullRequestPicker from "./PullRequestPicker.svelte";

  let {
    threadId,
    revision,
    onlinked,
    disabled = false,
    class: className,
  }: {
    threadId: string;
    revision: bigint;
    onlinked: (value: github.ThreadPullRequestsResponse) => void;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
</script>

<Popover bind:open label="Link pull request" sheet class={["w-[min(26rem,calc(100vw-1rem))]", className]}>
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      {disabled}
      class="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-base/5 text-zinc-700 focus-ring hover:bg-zinc-950/4 disabled:opacity-50 sm:min-h-8 sm:text-sm/5 dark:text-zinc-300 dark:hover:bg-white/5"
    >
      <Icon name="plus" /><span>Link pull request</span>
    </button>
  {/snippet}
  {#if open}<PullRequestPicker {threadId} {revision} {onlinked} />{/if}
</Popover>

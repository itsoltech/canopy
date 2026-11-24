<script lang="ts">
  import type { ThreadCreation } from "../thread-creation.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { fullAutoAvailable, permissionKey } from "../labels.ts";
  import ComposerBox from "./ComposerBox.svelte";
  import ComposerContextRow from "./ComposerContextRow.svelte";
  import PermissionPicker from "./PermissionPicker.svelte";
  import WorkerHoverCard from "#lib/features/overview/WorkerHoverCard.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";

  let { job }: { job: ThreadCreation } = $props();
  const overview = useOverview();
  const project = $derived(overview.projectChoice(job.snapshot?.projectId ?? ""));
  const workspace = $derived(project?.workspaces.find((entry) => entry.id === job.snapshot?.workspaceId));
  const worker = $derived(overview.worker(workspace?.workerId ?? ""));
  const sources = new MentionSources(() => undefined);
</script>

<div class="grid grid-cols-1 pt-2">
  <div data-thread-composer-slot class="t-composer-slot grid min-w-0 grid-cols-1 items-end">
    <div class="col-start-1 row-start-1">
      <ComposerBox
        shell
        disabled
        {sources}
        placeholder="Starting thread…"
        blockedReason="Wait for thread preparation to finish."
      >
        {#snippet drafts()}<span></span>{/snippet}
        {#snippet controls()}<PillText class="flex-1 text-right">{job.model || "Agent"}</PillText>{/snippet}
        {#snippet meta()}
          <ComposerContextRow>
            {#snippet computerControl()}<div inert class="w-full min-w-0">
                <WorkerHoverCard {worker} class="max-w-full" />
              </div>{/snippet}
            {#snippet permissionControl()}<PermissionPicker
                disabled
                provider={job.content?.provider}
                value={permissionKey(job.content?.permissionMode ?? 0)}
                fullAuto={fullAutoAvailable(job.content?.provider, worker?.os)}
                onselect={() => {}}
              />{/snippet}
          </ComposerContextRow>
        {/snippet}
      </ComposerBox>
    </div>
  </div>
</div>

<script lang="ts">
  import { copyJobPercent, copyJobState, copyJobTitle } from "@canopy/domain/workspace-copy-jobs";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import CopyJobDetails from "./CopyJobDetails.svelte";
  import { copyJobs } from "./copy-jobs.svelte.ts";

  /** Background workspace copies above the sidebar footer: one compact row each, details in a popover. */
  const overview = useOverview();
  let open = $state<string>();

  $effect(() => copyJobs.use(overview));

  // The first sync and every reload after a gap in the stream read the list again.
  $effect(() => {
    if (overview.resyncs) void copyJobs.load().catch(() => {});
  });
</script>

{#if copyJobs.listed.length}
  <GrowIn class="shrink-0">
    <ul
      role="list"
      aria-label="Workspace copies"
      class="sidebar-inset grid max-h-40 scroll-stable gap-0.5 overflow-y-auto border-t border-zinc-950/5 py-2 dark:border-white/5"
    >
      {#each copyJobs.listed as job (job.id)}
        <li>
          <Popover
            bind:open={() => open === job.id, (value) => (open = value ? job.id : undefined)}
            label="Workspace copy"
            placement="top-start"
            sheet
            class="w-[min(22rem,calc(100vw-1rem))]"
          >
            {#snippet trigger(props)}
              <button
                type="button"
                {...props}
                class="sidebar-row-padding grid w-full gap-1.5 rounded-lg py-1.5 text-left focus-ring hover:bg-hover"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <Icon
                    name={job.status === "failed" ? "exclamation-circle" : "document-duplicate"}
                    class={[
                      "size-4 shrink-0",
                      job.status === "failed" ? "text-rose-600 dark:text-rose-400" : "text-icon-muted",
                    ]}
                  />
                  <span class="min-w-0 flex-1 truncate">{copyJobTitle(job)}</span>
                  <span class="shrink-0 text-muted tabular-nums">{copyJobState(job)}</span>
                </span>
                {#if job.status !== "failed"}
                  <span
                    class="block h-0.5 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10"
                    aria-hidden="true"
                  >
                    <span
                      class="block h-full w-(--copy-progress) rounded-full bg-brand-600 transition-[width] duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none dark:bg-brand-500"
                      style:--copy-progress="{copyJobPercent(job)}%"
                    ></span>
                  </span>
                {/if}
              </button>
            {/snippet}
            <CopyJobDetails {job} />
          </Popover>
        </li>
      {/each}
    </ul>
  </GrowIn>
{/if}

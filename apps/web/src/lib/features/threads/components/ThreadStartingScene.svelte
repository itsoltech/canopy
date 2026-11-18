<script lang="ts">
  import { untrack } from "svelte";
  import type { ThreadCreation } from "../thread-creation.svelte.ts";
  import type { FeedScrollMemory } from "#lib/shared/ui/virtual/feed-scroll-memory.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useShell } from "#lib/features/navigation/shell.ts";
  import { sidebarTravel } from "#lib/features/navigation/sidebar-layout.svelte.ts";
  import { SummaryLayout } from "../summary/summary-layout.svelte.ts";
  import { formatTime } from "#lib/shared/format.ts";
  import UserMessageView from "./items/UserMessageView.svelte";
  import ThreadPreparation from "./ThreadPreparation.svelte";
  import ThreadStartingComposer from "./ThreadStartingComposer.svelte";
  import ThreadDay from "./ThreadDay.svelte";
  import MessageActionRow from "./MessageActionRow.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import WorkspaceTabs from "#lib/features/workspace/WorkspaceTabs.svelte";
  import WorkspaceFilesToggle from "#lib/features/workspace/WorkspaceFilesToggle.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import VirtualFeed from "#lib/shared/ui/virtual/VirtualFeed.svelte";

  let { job }: { job: ThreadCreation } = $props();
  const overview = useOverview();
  const shell = useShell();
  const snapshot = $derived(job.snapshot);
  const project = $derived(overview.projectChoice(snapshot?.projectId ?? ""));

  const home = $derived.by(() => {
    if (!snapshot?.projectId) return "/";
    const placement = new URLSearchParams({ project: snapshot.projectId });

    if (snapshot.workspaceId) placement.set("workspace", snapshot.workspaceId);

    return `/?${placement}`;
  });

  const rows = ["creation:start", "creation:input"];
  let rem = $state(16);
  let feed = $state<{ savePosition(): void }>();

  $effect(() => {
    const current = job;
    const capture = () => feed?.savePosition();
    current.capture = capture;

    return () => {
      capture();

      if (current.capture === capture) current.capture = undefined;
    };
  });

  const summary = new SummaryLayout({
    get rem() {
      return rem;
    },
    travel: () => sidebarTravel(shell.sidebar),
  });

  // The parent clears its handoff prop before the outgoing feed flushes during teardown.
  const currentJob = untrack(() => job);

  const scrollMemory: FeedScrollMemory = {
    initial: currentJob.scroll,
    save: (position) => {
      currentJob.scroll = position;
    },
  };

  const failureDetails = $derived(
    [
      ...new Set([
        ...(snapshot?.steps.filter((step) => step.status === "failed").map((step) => step.detail) ?? []),
        snapshot?.error ?? "",
      ]),
    ].filter(Boolean),
  );
</script>

<div class="relative flex h-full min-h-0 min-w-0 flex-col bg-surface">
  <span class="pointer-events-none invisible absolute w-[1rem]" bind:clientWidth={rem}></span>
  <TopBar>
    <Crumb markOnly href={home}
      >{#snippet mark()}<ProjectMark name={project?.name ?? "?"} kind={project?.kind} />{/snippet}{project?.name ??
        "Project"}</Crumb
    >
    {#snippet workspace()}<WorkspaceTabs title="Starting thread" />{/snippet}
    {#snippet actions()}
      <div class="max-sm:hidden"><IconButton disabled icon="ellipsis-horizontal" label="Thread actions" /></div>
      <WorkspaceFilesToggle disabled />
      <IconButton disabled size="sm" icon="arrows-right-left" label="Open diff" />
      <IconButton disabled size="sm" icon="computer-desktop" label="Open preview" />
    {/snippet}
  </TopBar>
  <div class="relative min-h-0 flex-1">
    <div
      id="workspace-content"
      role="tabpanel"
      aria-label="Thread"
      class="absolute inset-0 min-h-0 md:pl-9 md:[--chat-area-start:--spacing(9)]"
      bind:clientWidth={summary.width}
      style:--sidebar-width={shell.sidebar?.cssWidth}
      data-chat-placement
      data-chat-card={summary.card || undefined}
    >
      <span
        aria-hidden="true"
        class="pointer-events-none invisible absolute inset-x-0 md:left-9"
        {@attach summary.measure}
      ></span>
      <VirtualFeed
        bind:this={feed}
        {rows}
        {scrollMemory}
        key={(row) => row}
        group={(row) => row}
        estimate={(group) => (group === "creation:start" ? 36 : 300)}
        label="Timeline"
        footerFit={{ fold: "open", margin: 40 }}
      >
        {#snippet row(key: string)}
          {#if key === "creation:start"}<div class="pb-1"><ThreadDay at={job.at} /></div>
          {:else}
            <div class="pb-3" data-creation-input>
              {#if job.content}
                <UserMessageView
                  message={{
                    text: job.content.text,
                    mentions: job.content.mentions,
                    attachments: [],
                    authorAgentId: "",
                  }}
                  files={job.content.attachments}
                  quotes={job.content.quotes}
                />
                <MessageActionRow class="justify-end"
                  ><CopyButton text={job.content.text} label="Copy message" /><time
                    class="shrink-0 pl-1.5 text-zinc-500 tabular-nums dark:text-zinc-400">{formatTime(job.at)}</time
                  ></MessageActionRow
                >
              {/if}
              {#if snapshot && !job.unavailable}<div class="mt-3">
                  <ThreadPreparation steps={snapshot.steps} done={snapshot.done} failed={Boolean(snapshot.error)} />
                </div>{/if}
              {#if snapshot?.error || job.notice}
                <div
                  class="mt-3 grid justify-items-start gap-2 text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400"
                >
                  <p role="status">
                    {snapshot?.error && job.hasDraft
                      ? "Your draft is saved. Return to it to continue."
                      : snapshot?.error || job.notice}
                  </p>
                  {#if snapshot?.error}<Disclosure
                      >{#snippet summary()}Show details{/snippet}
                      <div class="mt-1 grid gap-1 break-words whitespace-pre-wrap">
                        {#each failureDetails as detail (detail)}<p>{detail}</p>{/each}
                      </div>
                      <div class="flex justify-end">
                        <CopyButton text={failureDetails.join("\n\n")} label="Copy details" />
                      </div></Disclosure
                    >{/if}
                  <div class="flex flex-wrap gap-2">
                    {#if job.hasDraft}<ButtonLink href={home} size="sm">Return to draft</ButtonLink>{/if}
                    {#if !snapshot?.done}<Button variant="ghost" size="sm" onclick={() => void job.refresh()}
                        >Check progress</Button
                      >{/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        {/snippet}
        {#snippet footer()}<ThreadStartingComposer {job} />{/snippet}
      </VirtualFeed>
    </div>
  </div>
</div>

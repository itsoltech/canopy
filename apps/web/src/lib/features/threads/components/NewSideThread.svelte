<script lang="ts">
  import CenteredContent from "#lib/shared/ui/CenteredContent.svelte";
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import type { Mention, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { AttachmentDraft, limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { effectiveEffort, type ModelOption } from "#lib/features/models/catalog.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useThreadModels } from "#lib/features/models/model-catalog.svelte.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import MachineBadge from "#lib/features/computers/MachineBadge.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { inheritedMode, permissionKey } from "../labels.ts";
  import { sideThreadDraft, usePermissionDrafts } from "../permission-drafts.svelte.ts";
  import ComposerBox from "./ComposerBox.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import PermissionPicker from "./PermissionPicker.svelte";
  import SideThreadContext from "./SideThreadContext.svelte";

  let { main, error, class: className }: { main: ui.Thread; error?: string | undefined; class?: ClassValue } = $props();

  const overview = useOverview();
  const settings = useSettings();
  const worker = $derived(overview.worker(main.workerId));
  const project = $derived(overview.project(main.projectId));
  const offer = useThreadModels(() => ({ thread: main, worker }));
  let picked = $state<ModelOption>();
  const option = $derived(picked ?? offer.current);
  let effort = $state<string>();

  const sentEffort = $derived(
    option && option.efforts.length > 0 ? (effort ?? effectiveEffort(option, main.effort)) : undefined,
  );

  // Your pick stays with this side thread's draft (leave and come back); unset = the main thread's mode.
  const permissions = usePermissionDrafts();
  const draftKey = $derived(sideThreadDraft(main.id));

  // Full access is picked again for a side thread, never taken over from the main thread.
  const mode = $derived(permissions.get(draftKey) ?? inheritedMode(permissionKey(main.permissionMode)));
  let fork = $state(true);
  let message = $state("");
  let mentions = $state<Mention[]>([]);
  let busy = $state(false);
  const clientRequestId = crypto.randomUUID();
  const sources = new MentionSources(() => ({ threadId: main.id }));
  const draft = new AttachmentDraft(() => limitsOf(settings.attachmentLimits));
  const href = $derived(`/threads/${encodeURIComponent(main.id)}`);
  const closed = $derived(main.status === "archived" || Boolean(main.deletedAt));

  function onkeydown(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      busy ||
      document.querySelector("dialog[open], [popover]:popover-open")
    )
      return;
    event.preventDefault();
    void goto(href);
  }
</script>

<svelte:window {onkeydown} />

<div class={["flex h-full min-w-0 flex-col", className]}>
  <TopBar>
    <Crumb
      href={project
        ? project.kind === "scratch"
          ? "/settings/threads"
          : `/settings/projects/${project.id}`
        : undefined}
      >{#snippet mark()}<ProjectMark name={project?.name ?? "?"} kind={project?.kind} />{/snippet}{project?.name ??
        "Project"}</Crumb
    >
    {#if main.nodeId}<li class="flex shrink-0 items-center">
        <MachineBadge nodeId={main.nodeId} compact class="max-w-20 sm:max-w-40" />
      </li>{/if}
    <Crumb {href}>{main.title || "Untitled thread"}</Crumb>
    <Crumb>New side thread</Crumb>
    {#snippet actions()}
      <ButtonLink {href} size="sm" icon="arrow-left" aria-label="Back to main thread">Back</ButtonLink>
    {/snippet}
  </TopBar>
  <CenteredContent class="grid max-w-(--chat-width) min-w-0 grid-cols-1 gap-8">
    <SideThreadContext {main} {worker} {project} />
    <form
      method="POST"
      action="?/createSideThread"
      class="grid min-w-0 grid-cols-1 gap-3"
      use:enhance={({ cancel }) => {
        if (busy || closed || !option || draft.blocker) return cancel();
        busy = true;
        const key = draftKey;
        return async ({ result, update }) => {
          try {
            if (result.type === "redirect") permissions.clear(key);
            await update({ reset: false });
          } finally {
            busy = false;
          }
        };
      }}
    >
      <input type="hidden" name="clientRequestId" value={clientRequestId} />
      <input type="hidden" name="model" value={picked?.model ?? main.model} />
      <input type="hidden" name="effort" value={sentEffort ?? ""} />
      <input type="hidden" name="permissionMode" value={mode} />
      <input type="hidden" name="fork" value={fork ? "on" : ""} />
      {#each draft.ids as id (id)}<input type="hidden" name="attachmentId" value={id} />{/each}
      {#if error}<Alert tone="error">{error}</Alert>{/if}
      <ComposerBox
        shell
        bind:value={message}
        bind:mentions
        {sources}
        {draft}
        sending={busy}
        disabled={busy || closed}
        canSend={Boolean(option) && !draft.blocker}
        autofocus
        label="Task for the side thread"
        sendLabel="Start side thread"
        blockedReason={closed
          ? "Reopen the main thread to start a side thread."
          : !option
            ? "The main thread's agent is unavailable."
            : undefined}
      >
        {#snippet controls()}
          {#if option}
            <ModelControls
              options={offer.options}
              bind:option={() => option, (next) => (picked = next)}
              bind:effort
              inherited={main.effort || undefined}
              workerId={main.workerId}
              class="flex-1 justify-end"
            />
          {/if}
        {/snippet}
        {#snippet meta()}
          <label class="flex min-w-0 items-center gap-2">
            <Switch
              name="continueHistory"
              label="Continue from the main thread's history"
              description="The side thread starts from the main thread's last completed turn."
              bind:checked={fork}
            />
            <span>Use main thread history</span>
          </label>
          {#if !closed && worker && !worker.online}<HintIcon
              warning
              label="Computer offline"
              text="This computer is offline. The side thread starts when it reconnects."
            />{/if}
          <PermissionPicker
            value={mode}
            onselect={(next) => permissions.set(draftKey, next)}
            class="-mr-1.5 shrink-0"
          />
        {/snippet}
      </ComposerBox>
    </form>
  </CenteredContent>
</div>

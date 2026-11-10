<script lang="ts">
  import { goto } from "$app/navigation";
  import { ui } from "@canopy/contracts";
  import { workerPresence } from "#lib/features/computers/computers.ts";
  import { paletteDialogClass } from "#lib/features/commands/palette-style.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { exitDuration, pageIn } from "#lib/shared/ui/motion.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import { backdropDismiss } from "#lib/shared/ui/backdrop.ts";
  import { decode } from "#lib/shared/wire.ts";
  import {
    SOURCES,
    addRequest,
    browseMode,
    type Choice,
    type SourceChoice,
    type SourceKind,
    type Step,
    type CopyStep,
  } from "./add-project-flow.ts";
  import type { AddProjectState } from "./add-project.svelte.ts";
  import BrowseStep from "./BrowseStep.svelte";
  import { repositoryName } from "./browse-path.ts";
  import { workspaceParent, workspaceDirectoryName } from "@canopy/domain/workspace-sources";
  import ChoiceStep from "./ChoiceStep.svelte";
  import UrlStep from "./UrlStep.svelte";
  import CopyWorkspaceStep from "./CopyWorkspaceStep.svelte";

  /**
   * Add project (docs/linked-computers.md, "Dodawanie projektu na dowolnym komputerze"): a keyboard-first dialog
   * that looks like the command palette. Choose a worker on any linked computer, a source (new, existing
   * directory, Git URL, GitHub), then a directory in its browser. The worker's home gateway adds it: a directory
   * whose Git origin matches a project there joins that project. Steps slide like palette submenus.
   */
  let { state: flow }: { state: AddProjectState } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  let dialog = $state<HTMLDialogElement>();
  let stack = $state.raw<(Step | CopyStep)[]>([{ kind: "worker" }]);
  let copySource = $state<ui.Workspace>();
  let direction = $state(1);
  let busy = $state(false);
  let error = $state<string>();
  let closing = $state(false);
  let closed: ReturnType<typeof setTimeout> | undefined;
  let opener: HTMLElement | undefined;
  let cloneUrl = $state("");
  let cloneUrlChosen = $state(false);

  const step = $derived<Step | CopyStep>(stack.at(-1) ?? { kind: "worker" });
  const computerOf = (worker: ui.Worker) => overview.machine(worker.nodeId) ?? "This computer";

  const workerChoices = $derived<Choice<ui.Worker>[]>(
    overview.workers
      .filter((worker) => !worker.revokedAt && (!worker.nodeId || capabilities?.linkedComputers))
      .sort(
        (a, b) =>
          Number(Boolean(a.nodeId)) - Number(Boolean(b.nodeId)) ||
          computerOf(a).localeCompare(computerOf(b)) ||
          a.name.localeCompare(b.name),
      )
      .map((worker) => {
        const presence = workerPresence(worker, overview.computer(worker.nodeId));
        const existing = flow.project?.workspaces.some((w) => w.workerId === worker.id);

        return {
          key: worker.id,
          value: worker,
          title: worker.name,
          detail: presence.online
            ? computerOf(worker)
            : (presence.reason ?? `${computerOf(worker)} · Start the worker to add projects`),
          status: existing ? "Already added" : presence.status,
          online: presence.online,
          disabled: existing || !presence.online,
        };
      }),
  );

  const sourceChoices = (worker: ui.Worker): Choice<SourceChoice>[] => [
    ...SOURCES.filter((source) => !flow.project || source.kind === "directory" || source.kind === "url").map(
      (source) => ({
        key: source.kind,
        value: source,
        title: flow.project && source.kind === "url" ? "Clone repository" : source.title,
        detail:
          source.creates && !worker.projectSources
            ? `Update Canopy on ${computerOf(worker)} to use this`
            : source.kind === "directory" && worker.nodeId
              ? `Browse a directory on ${computerOf(worker)}`
              : source.detail,
        icon: source.icon,
        mark: source.mark,
        disabled: source.creates && !worker.projectSources,
      }),
    ),
    ...(flow.project
      ? (overview.projectChoice(flow.project.id)?.workspaces ?? flow.project.workspaces).map((workspace) => {
          const from = overview.worker(workspace.workerId);
          const online = from && workerPresence(from, overview.computer(from.nodeId)).online;

          return {
            key: `copy:${workspace.id}`,
            value: { kind: "copy" as const, title: "Copy workspace", detail: "", creates: true, workspace },
            title: `Copy from ${from?.name || workspace.label || "workspace"}`,
            detail:
              !worker.workspaceCopy || !from?.workspaceCopy
                ? "Update this worker to copy files"
                : !online
                  ? "Start the source worker to copy files"
                  : workspace.rootPath,
            disabled: !worker.workspaceCopy || !from?.workspaceCopy || !online,
            icon: "folder-open" as const,
          };
        })
      : []),
  ];

  $effect(() => {
    if (!dialog) return;

    if (flow.open && !dialog.open) {
      clearTimeout(closed);
      closing = false;
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      stack = [{ kind: "worker" }];
      error = undefined;
      busy = false;
      dialog.showModal();
      cloneUrl = "";
      cloneUrlChosen = false;

      if (flow.project) void readCloneUrl(flow.project);
    }

    if (!flow.open && dialog.open) {
      dialog.close();
      exit();
    }
  });

  $effect(() => () => clearTimeout(closed));

  function exit() {
    if (!dialog) return;
    closing = true;
    clearTimeout(closed);
    closed = setTimeout(() => (closing = false), exitDuration(dialog));

    if (opener?.isConnected && (document.activeElement === document.body || dialog.contains(document.activeElement)))
      opener.focus({ preventScroll: true });
  }

  const close = () => {
    if (!busy) flow.open = false;
  };

  function push(next: Step | CopyStep) {
    direction = 1;
    error = undefined;
    stack = [...stack, next];
  }

  function back() {
    if (stack.length < 2 || busy) return;
    direction = -1;
    error = undefined;
    stack = stack.slice(0, -1);
  }

  function chooseSource(worker: ui.Worker, choice: SourceChoice) {
    const source = choice.kind;
    copySource = choice.workspace;
    push(
      source === "url" || source === "github"
        ? { kind: "remote", worker, source }
        : { kind: "browse", worker, source, remote: "" },
    );
  }

  async function readCloneUrl(project: ui.Project) {
    for (const workspace of project.workspaces) {
      try {
        const response = decode(
          ui.GetWorkspaceCloneSourceResponseSchema,
          await requestJson("GET", `/api/workspaces/${encodeURIComponent(workspace.id)}/clone-source`),
        );

        if (response.cloneUrl && flow.project?.id === project.id && !cloneUrlChosen) {
          cloneUrl = response.cloneUrl;

          return;
        }
      } catch {
        /* Another online workspace may provide the origin. The URL stays editable. */
      }
    }
  }

  async function add(worker: ui.Worker, source: SourceKind, url: string, target: { dir: string; name: string }) {
    busy = true;
    error = undefined;

    try {
      const response = decode(
        ui.AddProjectResponseSchema,
        await requestJson(
          "POST",
          "/api/projects",
          { ...addRequest(worker, browseMode(source), target, url), projectId: flow.project?.id },
          6.5 * 60_000,
        ),
      );

      const project = response.project;
      const name = (project && overview.projectChoice(project.id)?.name) ?? project?.name ?? "the project";
      busy = false;
      flow.open = false;
      toast(response.attached ? `Added to “${name}” as a new workspace` : `“${name}” added`);

      // Settings stay with each computer's own record: open this computer's one, if the project has it here.
      const local = project && overview.projectChoice(project.id)?.projectIds.find((id) => !id.includes("~"));

      if (flow.openProject && local) await goto(`/settings/projects/${encodeURIComponent(local)}`);
    } catch (cause) {
      busy = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<dialog
  use:windowModal
  bind:this={dialog}
  aria-label={flow.project ? "Add workspace" : "Add project"}
  onclose={() => {
    if (!flow.open) return;
    flow.open = false;
    exit();
  }}
  oncancel={(event) => busy && event.preventDefault()}
  {...backdropDismiss(close)}
  inert={closing || undefined}
  class={paletteDialogClass}
>
  {#if flow.open || closing}
    {#key stack.length}
      <div class="flex min-h-0 flex-1 flex-col" in:pageIn={{ from: direction }}>
        {#if step.kind === "worker"}
          <ChoiceStep
            label="Workers"
            placeholder="Search workers…"
            choices={workerChoices}
            onchoose={(worker) => push({ kind: "source", worker })}
            onclose={close}
          />
        {:else if step.kind === "source"}
          {@const worker = step.worker}
          <ChoiceStep
            label="Sources on {worker.name}"
            placeholder="Search sources…"
            choices={sourceChoices(worker)}
            onchoose={(source) => chooseSource(worker, source)}
            onback={back}
            onclose={close}
          />
        {:else if step.kind === "remote"}
          {@const { worker, source } = step}
          <UrlStep
            {source}
            initial={cloneUrl}
            computer={computerOf(worker)}
            oncontinue={(remote, url) => {
              cloneUrl = remote;
              cloneUrlChosen = true;
              push({ kind: "browse", worker, source, remote: url || remote });
            }}
            onback={back}
            onclose={close}
          />
        {:else if step.kind === "browse"}
          {@const { worker, source, remote } = step}
          <BrowseStep
            {worker}
            mode={browseMode(source)}
            actionLabel={flow.project
              ? source === "copy"
                ? "Choose files"
                : source === "directory"
                  ? "Add workspace"
                  : "Clone workspace"
              : undefined}
            name={flow.project
              ? workspaceDirectoryName(flow.project.workspaces[0]?.rootPath || flow.project.name)
              : remote
                ? repositoryName(remote)
                : ""}
            parent={flow.project ? workspaceParent(worker, overview.projects) : ""}
            {busy}
            {error}
            onsubmit={(target) =>
              source === "copy" && copySource
                ? push({ kind: "copy", worker, workspace: copySource, parent: target.dir, name: target.name })
                : add(worker, source, remote, target)}
            onback={back}
            onclose={close}
          />
        {:else if step.kind === "copy" && flow.project}
          <CopyWorkspaceStep
            project={flow.project}
            worker={step.worker}
            workspace={step.workspace}
            parent={step.parent}
            name={step.name}
            onbusy={(value) => (busy = value)}
            onback={back}
            onclose={close}
          />
        {/if}
      </div>
    {/key}
  {/if}
</dialog>

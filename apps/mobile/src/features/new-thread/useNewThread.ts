import { availablePermission } from "../threads/permissions";
import { useState } from "react";
import { create as createMessage } from "@bufbuild/protobuf";
import { router, useLocalSearchParams } from "expo-router";
import { PermissionMode, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import type { MobileComposerState } from "../drafts/store";
import type { ModelChoice } from "../models/catalog";
import { modelSections, useModelCatalog } from "../models/catalog";
import { effectiveThreadDefaults } from "@canopy/domain/new-thread-choices";
import { newThreadDraftTarget } from "@canopy/domain/composer-drafts";
import { usePersistentMessage } from "../drafts/usePersistentMessage";
import { useWorkerPresence } from "../computers/presence";
import { useWorkspaceDraft } from "./useWorkspaceDraft";
import { defaultProject, defaultWorkspace } from "./placement";
import { newThreadChoices } from "./choices";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";

/**
 * New thread: the project and the worker it runs on, the model and effort, the permission mode, files and the
 * first message. Everything starts from Settings → Threads (the project's defaults over yours) and what you
 * used last; what you pick here wins.
 */
export function useNewThread() {
  const overview = useOverview();
  const settings = useAppearance();
  const params = useLocalSearchParams<{ project?: string; workspace?: string }>();
  const [picks, setPicks] = useState<{ projectId?: string; workspaceId?: string; model?: string }>({});
  const initialLoading = !overview.loaded || (!settings.user && !settings.error);
  const message = usePersistentMessage(newThreadDraftTarget);
  const persistent = message.persistent;
  const pending = persistent?.pendingCreate;

  const projects = overview.projectChoices;
  const presence = useWorkerPresence();
  // A worker on a linked computer this one cannot reach counts as offline.
  const online = (workerId: string) => presence(overview.workers.find((w) => w.id === workerId)).online;
  const userDefaults = settings.user?.threadDefaults;

  const project =
    projects.find((p) => p.projectIds.includes(pending?.projectId ?? picks.projectId ?? params.project ?? "")) ??
    defaultProject(projects, overview.threads, userDefaults?.workspaceId ?? "");

  const defaults = effectiveThreadDefaults(userDefaults, project ? settings.projectDefaults(project.id) : undefined);

  const workspace = project
    ? (project.workspaces.find((w) => w.id === (pending?.workspaceId ?? picks.workspaceId ?? params.workspace)) ??
      (pending ? undefined : defaultWorkspace(project, overview.threads, defaults.workspaceId, online)))
    : undefined;

  const permission = persistent?.choices.permissionMode;

  const worker = overview.workers.find((w) => w.id === workspace?.workerId);
  const sections = modelSections(worker, useModelCatalog(worker?.id));
  const workspaceDraft = useWorkspaceDraft(workspace?.id, presence(worker).online);
  const choices = sections.flatMap((s) => s.choices);

  const lastUsedAgent = overview.lastUsedAgent;

  const choiceThreads =
    lastUsedAgent && !overview.threads.some((thread) => thread.id === lastUsedAgent.id)
      ? [...overview.threads, lastUsedAgent]
      : overview.threads;

  const { selected, model, effort, serviceTier } = newThreadChoices(
    sections,
    defaults,
    choiceThreads,
    persistent?.choices,
  );

  // A new message each render is fine: the suggestions key their requests by the scope's values.
  const mentionScope =
    workspace && selected
      ? createMessage(ui.MentionScopeSchema, {
          workspaceId: workspace.id,
          provider: selected.provider,
          providerProfileId: selected.profileId,
        })
      : undefined;

  const permissionMode = availablePermission(
    selected?.provider,
    permission ?? (defaults.permissionMode || PermissionMode.ASK),
  );

  const blocker = !project
    ? "Add a project in Settings → Projects to start a thread."
    : !workspace
      ? project.kind === "scratch"
        ? "Choose a worker with an allowed directory to start a scratch thread."
        : `${project.name} is not on any worker yet. Add a workspace in Settings → Projects.`
      : presence(worker).reason
        ? presence(worker).reason
        : !worker?.online
          ? `${worker?.name ?? "This worker"} is offline. Start it or choose another worker.`
          : !selected
            ? `${worker.name} reports no available agents. Check the worker in Settings.`
            : message.files.blocker;

  const request =
    workspace && selected
      ? createMessage(ui.CreateThreadRequestSchema, {
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          provider: selected.provider,
          providerProfileId: selected.profileId,
          model,
          effort,
          serviceTier,
          permissionMode,
          ...workspaceDraft.form,
          clientRequestId: persistent?.requestId ?? "",
        })
      : undefined;

  const { busy, error, create } = useNewThreadSubmit(request, message, !!blocker || initialLoading, project);

  return {
    projects,
    projectAway: (project: ui.Project) => projectAwayReason(project, overview.workers, overview.computers),
    workers: overview.workers,
    project,
    workspace,
    worker,
    sections,
    selected,
    effort,
    serviceTier,
    hasConfiguredSpeed: Boolean(serviceTier || persistent?.choices.serviceTier),
    permissionMode,
    message,
    workspaceDraft,
    mentionScope,
    /** The worker's presence, with its computer when that is a linked one. */
    workerPresence: presence(worker),
    busy,
    initialLoading,
    error,
    blocker,
    pickProject: (projectId: string) => {
      if (!persistent?.locked) setPicks({ ...picks, projectId, workspaceId: undefined });
    },
    pickWorkspace: (workspaceId: string) => {
      if (!persistent?.locked) setPicks({ ...picks, workspaceId });
    },
    ...modelActions(persistent, choices, selected, effort, serviceTier),
    setPermission: (next: PermissionMode) => persistent?.setChoices({ permissionMode: next }),
    create,
  };
}

function useNewThreadSubmit(
  request: ui.CreateThreadRequest | undefined,
  message: ReturnType<typeof usePersistentMessage>,
  blocked: boolean,
  project: ui.Project | undefined,
) {
  const { threadCreations } = useSession();
  const [error, setError] = useState("");

  function create() {
    if (!threadCreations || !request || blocked || message.persistent?.preparing) return;
    setError("");
    const outgoing = message.outgoing();

    const job = threadCreations.prepare(
      createMessage(ui.CreateThreadRequestSchema, {
        ...request,
        initialMessage: outgoing.text,
        initialAttachmentIds: outgoing.attachmentIds,
        initialMentions: outgoing.mentions,
        initialQuotes: outgoing.quotes,
      }),
      message.persistent,
      message.files.files.flatMap((file) => (file.attachment ? [file.attachment] : [])),
      project?.name ?? "",
    );

    if (!job) {
      setError("Could not start another thread. Wait for the current preparations to finish and try again.");

      return;
    }

    router.replace({ pathname: "/thread-starting/[id]", params: { id: job.id } });
    threadCreations.start(job.id);
  }

  return { busy: false, error, create };
}

function modelActions(
  persistent: MobileComposerState | undefined,
  choices: ModelChoice[],
  selected: ModelChoice | undefined,
  effort: string,
  serviceTier: string,
) {
  return {
    pickModel: (key: string) => {
      const choice = choices.find((c) => c.key === key);

      if (!choice) return;
      const sameAgent = choice.provider === selected?.provider && choice.profileId === selected.profileId;

      persistent?.setChoices({
        model: choice.model,
        provider: choice.provider,
        providerProfileId: choice.profileId,
        serviceTier:
          sameAgent && (serviceTier === "default" || choice.serviceTiers.includes(serviceTier)) ? serviceTier : "",
        effort: sameAgent && choice.efforts.includes(effort) ? effort : "",
      });
    },
    setEffort: (effort: string) =>
      persistent?.setChoices({
        effort,
        provider: selected?.provider,
        providerProfileId: selected?.profileId,
      }),
    setServiceTier: (serviceTier: string) =>
      persistent?.setChoices({
        serviceTier,
        provider: selected?.provider,
        providerProfileId: selected?.profileId,
      }),
  };
}

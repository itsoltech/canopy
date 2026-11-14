import { useRef, useState } from "react";
import { create as createMessage } from "@bufbuild/protobuf";
import { router, useLocalSearchParams } from "expo-router";
import { PermissionMode, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { findChoice, modelSections, useModelCatalog } from "../models/catalog";
import { usePersistentMessage } from "../drafts/usePersistentMessage";
import { createFromDraft } from "../drafts/create";
import { useWorkerPresence } from "../computers/presence";
import { useWorkspaceDraft } from "./useWorkspaceDraft";
import { defaultProject, defaultWorkspace, effectiveDefaults, modelFor } from "./placement";
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

  const projects = overview.projectChoices;
  const presence = useWorkerPresence();
  // A worker on a linked computer this one cannot reach counts as offline.
  const online = (workerId: string) => presence(overview.workers.find((w) => w.id === workerId)).online;
  const userDefaults = settings.user?.threadDefaults;

  const project =
    projects.find((p) => p.projectIds.includes(picks.projectId ?? params.project ?? "")) ??
    defaultProject(projects, overview.threads, userDefaults?.workspaceId ?? "");

  const defaults = effectiveDefaults(userDefaults, project ? settings.projectDefaults(project.id) : undefined);

  const workspace = project
    ? (project.workspaces.find((w) => w.id === (picks.workspaceId ?? params.workspace)) ??
      defaultWorkspace(project, overview.threads, defaults.workspaceId, online))
    : undefined;

  const message = usePersistentMessage(
    createMessage(ui.ComposerDraftTargetSchema, {
      projectId: workspace?.projectId ?? "",
      workspaceId: workspace?.id ?? "",
    }),
  );

  const persistent = message.persistent;
  const effort = persistent?.choices.effort ?? "";
  const permission = persistent?.choices.permissionMode;

  const worker = overview.workers.find((w) => w.id === workspace?.workerId);
  const sections = modelSections(worker, useModelCatalog(worker?.id));
  const workspaceDraft = useWorkspaceDraft(workspace?.id, presence(worker).online);
  const choices = sections.flatMap((s) => s.choices);

  const fromDefaults = defaultChoice(sections, defaults);

  const picked = choices.find(
    (c) =>
      c.model === persistent?.choices.model &&
      c.provider === persistent.choices.provider &&
      c.profileId === persistent.choices.providerProfileId,
  );

  const selected = picked ?? fromDefaults ?? findChoice(sections[0], "");

  // A new message each render is fine: the suggestions key their requests by the scope's values.
  const mentionScope =
    workspace && selected
      ? createMessage(ui.MentionScopeSchema, {
          workspaceId: workspace.id,
          provider: selected.provider,
          providerProfileId: selected.profileId,
        })
      : undefined;

  const permissionMode = permission ?? (defaults.permissionMode || PermissionMode.ASK);

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
          model: !picked && selected.isDefault ? "" : selected.model,
          effort: selected.efforts.includes(effort) ? effort : "",
          permissionMode,
          ...workspaceDraft.form,
          clientRequestId: persistent?.requestId ?? "",
        })
      : undefined;

  const { busy, error, create } = useNewThreadSubmit(request, message, initialLoading || Boolean(blocker));

  return {
    projects,
    projectAway: (project: ui.Project) => projectAwayReason(project, overview.workers, overview.computers),
    workers: overview.workers,
    project,
    workspace,
    worker,
    sections,
    selected,
    effort: selected?.efforts.includes(effort) ? effort : selected?.defaultEffort || "",
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
    pickProject: (projectId: string) => setPicks({ ...picks, projectId, workspaceId: undefined }),
    pickWorkspace: (workspaceId: string) => setPicks({ ...picks, workspaceId }),
    pickModel: (key: string) => {
      const choice = choices.find((c) => c.key === key);

      if (choice)
        persistent?.setChoices({ model: choice.model, provider: choice.provider, providerProfileId: choice.profileId });
    },
    setEffort: (next: string) => persistent?.setChoices({ effort: next }),
    setPermission: (next: PermissionMode) => persistent?.setChoices({ permissionMode: next }),
    create,
  };
}

function defaultChoice(sections: ReturnType<typeof modelSections>, defaults: ReturnType<typeof effectiveDefaults>) {
  const ofProvider = sections.filter((s) => s.provider === defaults.provider);
  const section = ofProvider.find((s) => s.profileId === defaults.providerProfileId) ?? ofProvider[0];

  return section ? findChoice(section, modelFor(defaults, section.provider)) : undefined;
}

function useNewThreadSubmit(
  request: ui.CreateThreadRequest | undefined,
  message: ReturnType<typeof usePersistentMessage>,
  blocked: boolean,
) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);

  async function create() {
    if (!client || !request || blocked || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const outgoing = message.outgoing();

    try {
      const result = await createFromDraft(
        client.api,
        message.persistent,
        createMessage(ui.CreateThreadRequestSchema, {
          ...request,
          initialMessage: outgoing.text,
          initialAttachmentIds: outgoing.attachmentIds,
          initialMentions: outgoing.mentions,
          initialQuotes: outgoing.quotes,
        }),
      );

      if (result.thread) {
        message.clear();
        router.replace({ pathname: "/thread/[id]", params: { id: result.thread.id } });
      }
    } catch {
      setError("Could not start the thread. Check the worker and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return { busy, error, create };
}

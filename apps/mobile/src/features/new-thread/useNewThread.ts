import { useRef, useState } from "react";
import { router } from "expo-router";
import * as Crypto from "expo-crypto";
import { PermissionMode } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { findChoice, modelSections, useModelCatalog } from "../models/catalog";
import { useMessageDraft } from "../composer/useMessageDraft";
import { useWorkerPresence } from "../computers/presence";
import { useWorkspaceDraft } from "./useWorkspaceDraft";
import { defaultProject, defaultWorkspace, effectiveDefaults, modelFor } from "./placement";

/**
 * New thread: the project and the worker it runs on, the model and effort, the permission mode, files and the
 * first message. Everything starts from Settings → Threads (the project's defaults over yours) and what you
 * used last; what you pick here wins.
 */
export function useNewThread() {
  const { client } = useSession();
  const overview = useOverview();
  const settings = useAppearance();
  const [picks, setPicks] = useState<{ projectId?: string; workspaceId?: string; model?: string }>({});
  const [effort, setEffort] = useState("");
  const [permission, setPermission] = useState<PermissionMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const message = useMessageDraft();
  const requestId = useRef(Crypto.randomUUID());
  const sending = useRef(false);

  const projects = overview.projects.filter((p) => !p.archivedAt);
  const presence = useWorkerPresence();
  // A worker on a linked computer this one cannot reach counts as offline.
  const online = (workerId: string) => presence(overview.workers.find((w) => w.id === workerId)).online;
  const userDefaults = settings.user?.threadDefaults;

  const project =
    projects.find((p) => p.id === picks.projectId) ??
    defaultProject(projects, overview.threads, userDefaults?.workspaceId ?? "");

  const defaults = effectiveDefaults(userDefaults, project ? settings.projectDefaults(project.id) : undefined);

  const workspace = project
    ? (project.workspaces.find((w) => w.id === picks.workspaceId) ??
      defaultWorkspace(project, overview.threads, defaults.workspaceId, online))
    : undefined;

  const worker = overview.workers.find((w) => w.id === workspace?.workerId);
  const sections = modelSections(worker, useModelCatalog(worker?.id));
  const workspaceDraft = useWorkspaceDraft(workspace?.id, presence(worker).online);
  const choices = sections.flatMap((s) => s.choices);

  const fromDefaults = (() => {
    const ofProvider = sections.filter((s) => s.provider === defaults.provider);
    const section = ofProvider.find((s) => s.profileId === defaults.providerProfileId) ?? ofProvider[0];

    return section ? findChoice(section, modelFor(defaults, section.provider)) : undefined;
  })();

  const picked = choices.find((c) => c.key === picks.model);
  const selected = picked ?? fromDefaults ?? findChoice(sections[0], "");
  const permissionMode = permission ?? (defaults.permissionMode || PermissionMode.ASK);

  const blocker = !project
    ? "Create a project in Canopy on the web first."
    : !workspace
      ? project.kind === "scratch"
        ? "Choose a worker with an allowed directory to start a scratch thread."
        : `${project.name} is not on any worker yet. Add it to a worker in Canopy on the web.`
      : presence(worker).reason
        ? presence(worker).reason
        : !worker?.online
          ? `${worker?.name ?? "This worker"} is offline. Start it or choose another worker.`
          : !selected
            ? `${worker.name} reports no available agents. Check the worker in Settings.`
            : message.files.blocker;

  async function create() {
    if (!client || !workspace || !selected || blocker || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const outgoing = message.outgoing();

    try {
      const result = await client.api.createThread(
        {
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          provider: selected.provider,
          providerProfileId: selected.profileId,
          // Not picked and the instance's default: follow the instance's default model.
          model: !picked && selected.isDefault ? "" : selected.model,
          effort: selected.efforts.includes(effort) ? effort : "",
          permissionMode,
          initialMessage: outgoing.text,
          initialAttachmentIds: outgoing.attachmentIds,
          initialMentions: outgoing.mentions,
          ...workspaceDraft.form,
          clientRequestId: requestId.current,
        },
        { timeoutMs: 20_000 },
      );

      if (result.thread) router.replace({ pathname: "/thread/[id]", params: { id: result.thread.id } });
    } catch {
      setError("Could not start the thread. Check the worker and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return {
    projects,
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
    /** The worker's presence, with its computer when that is a linked one. */
    workerPresence: presence(worker),
    busy,
    error,
    blocker,
    pickProject: (projectId: string) => setPicks({ ...picks, projectId, workspaceId: undefined }),
    pickWorkspace: (workspaceId: string) => setPicks({ ...picks, workspaceId }),
    pickModel: (model: string) => setPicks({ ...picks, model }),
    setEffort,
    setPermission,
    create,
  };
}

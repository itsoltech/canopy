import { supportsNativeGoals } from "@canopy/domain/harnesses";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, ui, type SandboxProfileBinding } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { corePrepareWorkspace, resolveWorkspaceMode, type PreparedWorkspace } from "../worktrees/core-worktrees.ts";
import { coreNameBranchLater } from "../worktrees/branch-naming.ts";
import { prepareAgentStartWorktree } from "../worktrees/agent-start-worktree.ts";
import { DRAFT_SANDBOX_RESELECT, SANDBOX_DERIVATION_UNAVAILABLE, threadSandbox } from "../store/thread-sandbox.ts";
import type { AutomatedAccess } from "../store/automated-permissions.ts";
import { harnessOf, turnEffort, type ThreadRow } from "../store/index.ts";
import { coreBroadcastTurn, coreRun } from "./core-broadcast.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { coreCheckProvider, coreForkRequest, coreStartThread } from "./core-threads.ts";
import { coreAutoTitle, coreUiThread } from "./core-titles.ts";
import { coreMessageAttachments } from "./core-attachments.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { coreCheckModel, coreProfileModels } from "./core-models.ts";
import { coreGoals } from "./core-goals.ts";
import {
  checkSandboxPlacement,
  ownerSandboxBinding,
  sandboxGoalText,
  SANDBOX_GOAL_UNAVAILABLE,
  SANDBOX_MODE_REQUIRED,
  SANDBOX_SHELL_UNAVAILABLE,
} from "./thread-sandbox.ts";
import { coreShellInput } from "./core-shell.ts";
import { requireThreadModule } from "./thread-module-runtime.ts";
import type { GatewayCore } from "./core.ts";
import { checkedQuotes, coreCheckQuoteSources } from "./quotes.ts";
import { isPlatformCommand } from "./mentions.ts";
import type { CreationProgress } from "./thread-progress.ts";
import { inheritThreadServiceTier } from "./thread-service-tier.ts";
import { titleContext } from "./thread-titles.ts";
import {
  failWorktreePreparation,
  finishWorktreePlacement,
  reserveWorktreeThread,
  singleCreation,
} from "./worktree-preparation.ts";

interface RemoteParent {
  ref: string;
  kind: string;
  instructions: string;
  interactions: string;
  permissionModeNote?: string;
}

interface CreationOptions {
  remoteParent: RemoteParent | undefined;
  ownerInput: boolean;
  automated: AutomatedAccess | undefined;
  progress: CreationProgress | undefined;
  initialTurn?: (row: ThreadRow) => Promise<void>;
}

async function completedCreation(core: GatewayCore, input: ui.CreateThreadRequest) {
  const previous = await coreRun(core, (s) =>
    s.threadByCreation(core[coreState].options.userId, input.clientRequestId),
  );

  if (!previous) return;

  const binding = threadSandbox(previous);

  if (input.sandboxProfileDigest && input.sandboxProfileDigest !== binding?.digest)
    throw new InvalidError(DRAFT_SANDBOX_RESELECT);

  if (input.sandboxProfileId && input.sandboxProfileId !== binding?.profile?.id)
    throw new InvalidError("This request already created a thread with a different sandbox selection.");

  if (previous.preparation_fingerprint)
    throw new InvalidError(previous.status_detail ?? "This thread is still being prepared.");

  const ready =
    (!input.initialMessage && !input.initialAttachmentIds.length && !input.initialQuotes.length) ||
    (await coreRun(core, (s) => s.turnByClientRequest(previous.id, input.clientRequestId))) ||
    (input.initialMentions.some(isPlatformCommand) && (await coreGoals(core, (s) => s.latest(previous.id))));

  if (!ready) return;

  if (previous.status === "creating") await coreStartThread(core, previous);

  return coreUiThread(core, previous);
}

async function checkPlacement(core: GatewayCore, input: ui.CreateThreadRequest, automated?: AutomatedAccess) {
  if (input.parentThreadId) {
    const parent = await coreRun(core, (s) => s.thread(input.parentThreadId));

    if (parent.owner_user_id === core[coreState].options.userId && threadSandbox(parent))
      throw new InvalidError(SANDBOX_DERIVATION_UNAVAILABLE);
  }

  const source =
    input.forkAtTurnId && !input.parentThreadId ? await coreForkRequest(core, input, automated !== undefined) : input;

  const asked = await inheritThreadServiceTier(core, source);

  await coreCheckProvider(core, asked, automated !== undefined);

  const where = { workspaceId: asked.workspaceId, provider: asked.provider, profileId: asked.providerProfileId };
  await coreCheckModel(core, where, asked.model, asked.effort, asked.serviceTier);
  const effort = turnEffort((await coreProfileModels(core, where)).models, asked.model, asked.effort);

  return resolveWorkspaceMode(core, effort === asked.effort ? asked : { ...asked, effort });
}

async function prepareInitialMessage(core: GatewayCore, request: ui.CreateThreadRequest, ownerInput: boolean) {
  if (
    !request.initialAttachmentIds.length &&
    !request.initialMentions.length &&
    !request.initialQuotes.length &&
    !(ownerInput && request.initialMessage.startsWith("!"))
  )
    return;

  const projects = await coreRun(core, (s) => s.listProjects(core[coreState].options.userId));
  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);

  const files = request.initialAttachmentIds.length
    ? await coreMessageAttachments(core, request.initialAttachmentIds, workspace?.workerId ?? "")
    : undefined;

  const { mentions, goal } = await coreMessageMentions(
    core,
    { workspaceId: request.workspaceId, cwd: request.cwd || workspace?.rootPath || "" },
    request.initialMessage,
    request.initialMentions,
    files?.files,
  );

  const quotes = checkedQuotes(
    request.initialQuotes,
    (reason) => new InvalidError(reason),
    request.initialMessage,
    request.initialMentions,
  );

  for (const quote of quotes)
    if (quote.sourceThreadId) await coreCheckQuoteSources(core, [quote], quote.sourceThreadId);

  if (goal !== undefined && files) throw new InvalidError("a /goal message cannot carry attachments");

  const shell = ownerInput
    ? coreShellInput(request.initialMessage, Boolean(files || request.initialMentions.length))
    : undefined;

  return { files, mentions, goal, quotes, shell };
}

type InitialMessage = Awaited<ReturnType<typeof prepareInitialMessage>>;

async function annotateRemoteParent(core: GatewayCore, row: ThreadRow, parent: RemoteParent) {
  await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET remote_parent_ref=${parent.ref},remote_parent_kind=${parent.kind},interaction_route=${parent.interactions},settings=settings || ${JSON.stringify({ instructions: parent.instructions })}::jsonb WHERE id=${row.id}::uuid`;
    }),
  );
  row.remote_parent_ref = parent.ref;
  row.remote_parent_kind = parent.kind;
  row.interaction_route = parent.interactions === "human" ? "human" : "parent";
  row.settings.instructions = parent.instructions;
}

async function startPreparedThread(
  core: GatewayCore,
  prepared: PreparedWorkspace,
  message: InitialMessage,
  options: CreationOptions,
  pending?: ThreadRow,
  sandboxProfile?: SandboxProfileBinding,
) {
  const { request } = prepared;

  const {
    actions,
    options: { userId },
  } = core[coreState];

  const commit = async () => {
    await requireThreadModule(core);

    const humanAuthored =
      options.ownerInput && !options.automated && !message?.shell && !!request.initialMessage.trim();

    const row = pending
      ? await finishWorktreePlacement(core, pending, request)
      : await coreRun(core, (s) =>
          s.createThread(
            userId,
            message || options.initialTurn ? { ...request, initialMessage: "" } : request,
            undefined,
            options.automated,
            undefined,
            undefined,
            humanAuthored,
            sandboxProfile,
          ),
        );

    if (options.remoteParent) await annotateRemoteParent(core, row, options.remoteParent);

    if (options.initialTurn) await options.initialTurn(row);
    else if (message?.goal === undefined && (message || (pending && request.initialMessage.trim()))) {
      const input =
        message &&
        (message.shell ??
          coreComposeInput(
            core,
            harnessOf(request.provider)!,
            request.initialMessage,
            message.mentions,
            message.files?.input(row.id, request.initialMessage, message.mentions),
            message.quotes,
          ));

      const turn = await coreRun(core, (s) =>
        s.enqueueTurn({
          threadId: row.id,
          text: request.initialMessage,
          userId,
          clientRequestId: request.clientRequestId,
          ...(humanAuthored
            ? {
                input: {
                  ...input,
                  text: input?.text ?? request.initialMessage,
                  message: request.initialMessage,
                  humanAuthored,
                },
              }
            : input && { input }),
        }),
      );

      if (pending) actions.defer(() => coreBroadcastTurn(core, row.id, turn.id));
    }

    await coreStartThread(core, row);

    if (message?.goal !== undefined)
      await core.setGoal(create(ui.SetGoalRequestSchema, { threadId: row.id, action: "set", objective: message.goal }));

    return row;
  };

  const row = await actions.transaction(commit);

  if (prepared.nameLater) coreNameBranchLater(core, row, request.initialMessage, prepared.nameLater.worktree);

  if (message?.goal === undefined && (message || request.initialMessage.trim()))
    coreAutoTitle(
      core,
      row.id,
      titleContext({
        text: request.initialMessage,
        mentions: message?.mentions,
        attachments: message?.files?.input(row.id, request.initialMessage).attachments,
      }),
    );

  return coreUiThread(core, row);
}

async function createOnce(
  core: GatewayCore,
  input: ui.CreateThreadRequest,
  options: CreationOptions,
  fingerprint?: string,
) {
  const { progress } = options;

  if (input.sandboxProfileId && (!options.ownerInput || options.automated || options.remoteParent))
    throw new InvalidError("Only the owner can select a sandbox profile.");

  if (input.sandboxProfileDigest && !input.sandboxProfileId) throw new InvalidError(DRAFT_SANDBOX_RESELECT);

  progress?.("check_workspace", "running");
  const previous = await completedCreation(core, input);

  if (previous) {
    progress?.("check_workspace", "completed");
    progress?.("fetch_remote", "skipped", "Thread already created.");
    progress?.("create_worktree", "skipped", "Thread already created.");
    progress?.("prepare_message", "skipped", "Thread already created.");

    return previous;
  }

  const asked = await checkPlacement(core, input, options.automated);

  if (
    !supportsNativeGoals(asked.provider) &&
    asked.initialMentions.some((m) => isPlatformCommand(m) && m.name === "goal")
  )
    throw new InvalidError("This provider does not support native goals.");

  const sandbox = await creationSandbox(core, asked);

  if (sandbox && asked.initialMessage.startsWith("!")) throw new InvalidError(SANDBOX_SHELL_UNAVAILABLE);

  if (sandbox && sandboxGoalText(asked.initialMessage)) throw new InvalidError(SANDBOX_GOAL_UNAVAILABLE);

  const pending =
    fingerprint && asked.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE
      ? await reserveWorktreeThread(core, asked, fingerprint, sandbox)
      : undefined;

  try {
    const prepared =
      options.initialTurn && asked.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE
        ? await prepareAgentStartWorktree(core, asked)
        : await corePrepareWorkspace(core, asked, progress);

    progress?.("check_workspace", "completed");

    if (prepared.request.workspaceMode !== ui.WorkspaceMode.NEW_WORKTREE) {
      progress?.("fetch_remote", "skipped");
      progress?.("create_worktree", "skipped");
    }

    progress?.("prepare_message", "running");
    const message = await prepareInitialMessage(core, prepared.request, options.ownerInput);

    if (sandbox && message?.shell) throw new InvalidError(SANDBOX_SHELL_UNAVAILABLE);

    if (sandbox && message?.goal !== undefined) throw new InvalidError(SANDBOX_GOAL_UNAVAILABLE);
    progress?.("prepare_message", "completed");
    progress?.("start_thread", "running");

    return await startPreparedThread(core, prepared, message, options, pending, sandbox);
  } catch (error) {
    if (pending) await failWorktreePreparation(core, pending, error);
    throw error;
  }
}

async function creationSandbox(core: GatewayCore, request: ui.CreateThreadRequest) {
  if (!request.sandboxProfileId) return;

  if (request.permissionMode !== PermissionMode.FULL_AUTO) throw new InvalidError(SANDBOX_MODE_REQUIRED);

  const profile = await ownerSandboxBinding(core, request.sandboxProfileId, request.sandboxProfileDigest);
  const projects = await coreRun(core, (s) => s.listProjects(core[coreState].options.userId));
  const workspace = projects.flatMap((project) => project.workspaces).find((item) => item.id === request.workspaceId);

  if (!workspace) throw new InvalidError("Workspace not found.");
  await checkSandboxPlacement(core, workspace.workerId, request.provider, request.providerProfileId, profile);

  return profile;
}

export function coreCreateThread(
  this: GatewayCore,
  input: ui.CreateThreadRequest,
  remoteParent?: RemoteParent,
  ownerInput = false,
  automated = remoteParent ? { permissionModeNote: remoteParent.permissionModeNote ?? "" } : undefined,
  progress?: CreationProgress,
): Promise<ui.Thread> {
  const options = { remoteParent, ownerInput, automated, progress };

  if (ownerInput && !automated && input.clientRequestId && !input.parentThreadId && !input.forkAtTurnId)
    return singleCreation(
      this,
      input,
      (fingerprint) => createOnce(this, input, options, fingerprint),
      () => progress?.("start_thread", "running"),
    );

  return createOnce(this, input, options);
}

export function createThreadWithAgentTurn(
  core: GatewayCore,
  input: ui.CreateThreadRequest,
  automated: AutomatedAccess,
  initialTurn: (row: ThreadRow) => Promise<void>,
): Promise<ui.Thread> {
  return createOnce(core, input, {
    ownerInput: false,
    automated,
    initialTurn,
    remoteParent: undefined,
    progress: undefined,
  });
}

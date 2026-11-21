import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Code, ConnectError } from "@connectrpc/connect";
import { splitId } from "@canopy/domain/computers";
import { WORKTREE_CLIENT_TIMEOUT_MS } from "@canopy/domain/worktree-timing";
import type { GitRefs, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useComputerHome } from "../computers/presence";

const rejectedRequests = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.FailedPrecondition,
  Code.Unimplemented,
]);

function preferredBaseRef(refs: GitRefs, branch?: string, baseRef?: string) {
  const preferred = [branch, baseRef, refs.defaultBranch, refs.currentBranch];

  return preferred.find((name) => refs.refs.some((ref) => ref.name === name)) || refs.refs[0]?.name || "";
}

/** Keep the same creation intent after a timeout, including when the sheet closes. */
export function useWorktreeContinuation(thread: ui.Thread) {
  const { client, online } = useSession();
  const { projects, workers, settleThread } = useOverview();
  const home = useComputerHome(thread.nodeId || splitId(thread.id).node);
  const worker = workers.find((row) => row.id === thread.workerId);

  const workspace = projects
    .find((row) => row.id === thread.projectId)
    ?.workspaces.find((row) => row.id === thread.workspaceId);

  const reason = home.away
    ? "This computer is unreachable. Reconnect it to continue."
    : !online || !client
      ? "Canopy is offline. Reconnect to continue."
      : !workspace
        ? "The source workspace is unavailable. Check project settings to continue."
        : !worker?.online
          ? "The worker is offline. Start it to continue."
          : !worker.worktrees
            ? "This worker cannot create worktrees. Update it to continue."
            : thread.deletedAt
              ? "This thread is deleted. Restore it to continue."
              : "";

  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<GitRefs>();
  const [baseRef, setBaseRef] = useState("");
  const [failure, setFailure] = useState("");
  const [details, setDetails] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<{ baseRef: string; clientRequestId: string } | undefined>(undefined);
  const lock = useRef(false);

  useEffect(() => {
    if (!client || !visible || reason || pending.current) return;
    let active = true;
    setLoading(true);
    setFailure("");
    setDetails("");
    setRefs(undefined);
    void client.api
      .listGitRefs({ workspaceId: thread.workspaceId }, { timeoutMs: 35_000 })
      .then((result) => {
        if (!active) return;

        if (!result.supported || !result.refs?.isRepo) {
          setFailure("The source workspace cannot create worktrees. Check its Git repository, then reload refs.");

          return;
        }

        const available = result.refs;
        setRefs(available);
        setBaseRef(preferredBaseRef(available, thread.worktree?.branch, thread.worktree?.baseRef));

        if (!available.refs.length) setFailure("No base refs are available. Add a branch, then reload refs.");
      })
      .catch((cause) => {
        if (!active) return;
        setFailure("Could not load base refs. Check the worker, then reload refs.");
        setDetails(ConnectError.from(cause).rawMessage);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client, visible, reason, thread.workspaceId, thread.worktree?.branch, thread.worktree?.baseRef, refresh]);

  async function start() {
    if (!client || reason || loading || !baseRef || (!pending.current && !refs) || lock.current) return;
    lock.current = true;
    const intent = pending.current ?? { baseRef, clientRequestId: Crypto.randomUUID() };
    pending.current = intent;
    setAttempted(true);
    setBusy(true);
    setFailure("");
    setDetails("");

    try {
      const result = await client.api.continueThreadInWorktree(
        { threadId: thread.id, ...intent },
        { timeoutMs: WORKTREE_CLIENT_TIMEOUT_MS },
      );

      if (!result.thread) throw new Error("Missing continued thread");
      settleThread(result.thread);
      pending.current = undefined;
      setAttempted(false);
      setVisible(false);
      router.push({ pathname: "/thread/[id]", params: { id: result.thread.id } });
    } catch (cause) {
      const error = ConnectError.from(cause);

      if (rejectedRequests.has(error.code)) {
        pending.current = undefined;
        setAttempted(false);
      }

      setFailure(
        error.code === Code.Unimplemented
          ? "This gateway cannot continue removed worktrees. Update Canopy, then retry."
          : "Could not open the new thread. Check the worker and connection, then retry.",
      );
      setDetails(error.rawMessage);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return {
    visible,
    setVisible,
    reason,
    loading,
    busy,
    refs,
    baseRef,
    setBaseRef,
    failure,
    details,
    attempted,
    reload: () => setRefresh((value) => value + 1),
    start: () => void start(),
  };
}

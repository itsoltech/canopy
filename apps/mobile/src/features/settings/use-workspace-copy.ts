import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { ui, type WorkspaceCopyManifest } from "@canopy/contracts";
import { copySelection, copySelectable, copyTotals, copyUnavailableReason } from "@canopy/domain/workspace-copy";
import * as Crypto from "expo-crypto";
import { copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
import { useSession } from "../../state/session";
import { mergeCopyJob, useCopyJobs } from "../copy-jobs/store";

export interface WorkspaceCopyProps {
  project: ui.Project;
  worker: ui.Worker;
  workspace: ui.Workspace;
  initialParent: string;
  initialName: string;
  onBusy: (value: boolean) => void;
  onBack: () => void;
  onSaved: () => void;
}

export function useWorkspaceCopy(props: WorkspaceCopyProps) {
  const { client } = useSession();
  const [parent, setParent] = useState(props.initialParent);
  const [name, setName] = useState(props.initialName);
  const [manifest, setManifest] = useState<WorkspaceCopyManifest>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [jobId, setJobId] = useState("");
  const { running, progress, cancelled, jobError } = useCopyJob(jobId);
  const busy = starting || running;
  const error = failure || jobError;
  const manifestToken = useRef("");
  const entries = useMemo(() => copySelection(manifest?.entries ?? [], selected), [manifest, selected]);
  const totals = useMemo(() => copyTotals(entries), [entries]);
  const disabledReason = copyUnavailableReason(entries);
  const secrets = useMemo(() => entries.filter((e) => e.secret && !e.directory), [entries]);

  const skipped = useMemo(
    () => manifest?.entries.filter((e) => copySelectable(e) && !e.directory && !selected.has(e.path)).length ?? 0,
    [manifest, selected],
  );

  useEffect(
    () => () => {
      void releaseCopy(client, props.workspace.id, manifestToken.current);
    },
    [client, props.workspace.id],
  );

  async function load() {
    if (!client) return;
    setLoading(true);
    setFailure("");
    setConfirming(false);
    setConfirmed(false);
    setJobId("");

    try {
      await releaseCopy(client, props.workspace.id, manifestToken.current);

      const result = (
        await client.api.getWorkspaceCopyManifest({ workspaceId: props.workspace.id }, { timeoutMs: 130_000 })
      ).manifest;

      setManifest(result);
      manifestToken.current = result?.token ?? "";
      setSelected(new Set(result?.entries.filter((e) => copySelectable(e) && e.included).map((e) => e.path)));
    } catch (cause) {
      setFailure(copyMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!client || !manifest || busy || disabledReason) return;

    if (secrets.length && !confirmed) {
      setConfirming(true);

      return;
    }

    setStarting(true);
    props.onBusy(true);
    setFailure("");

    try {
      const started = await client.api.startWorkspaceCopy(
        {
          sourceRef: props.workspace.id,
          targetRef: props.worker.id,
          projectRef: props.project.id,
          manifestToken: manifest.token,
          ignoredSelection: { paths: [...selected] },
          confirmedSecrets: confirmed ? secrets.map((e) => e.path) : [],
          parentPath: parent,
          name,
          targetName: props.worker.name,
          transferKey: Crypto.randomUUID(),
        },
        { timeoutMs: 140_000 },
      );

      // The gateway owns the file list from here on and releases it.
      manifestToken.current = "";
      mergeCopyJob(started);
      setJobId(started.id);
    } catch (cause) {
      setFailure(copyMessage(cause));
    } finally {
      setStarting(false);
      props.onBusy(false);
    }
  }

  return {
    parent,
    setParent,
    name,
    setName,
    manifest,
    selected,
    setSelected,
    loading,
    busy,
    error,
    confirming,
    setConfirming,
    confirmed,
    setConfirmed,
    cancelled,
    progress,
    totals,
    disabledReason,
    secrets,
    skipped,
    load,
    copy,
    running,
    cancel: () => void cancelCopy(client, jobId).catch((cause: unknown) => setFailure(copyMessage(cause))),
  };
}

function copyMessage(cause: unknown) {
  return cause instanceof ConnectError ? cause.rawMessage : "Workspace copy failed. Check the connection and retry.";
}

async function releaseCopy(client: ReturnType<typeof useSession>["client"], workspaceId: string, token: string) {
  if (token)
    await client?.api.workspaceCopySource({ workspaceId, token, release: true }, { timeoutMs: 15_000 }).catch(() => {});
}

/** The started copy, followed live; it runs in the gateway, so leaving the screen does not stop it. */
function useCopyJob(id: string) {
  const job = useCopyJobs().jobs.get(id);

  return {
    running: !!job && copyJobRunning(job),
    progress: job?.progress,
    cancelled: job?.status === "cancelled",
    jobError: job?.status === "failed" ? job.error : "",
  };
}

async function cancelCopy(client: ReturnType<typeof useSession>["client"], id: string) {
  if (client && id) mergeCopyJob(await client.api.cancelWorkspaceCopyJob({ id }, { timeoutMs: 40_000 }));
}

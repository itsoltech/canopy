import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { ui, type WorkspaceCopyManifest } from "@canopy/contracts";
import { copySelection, copySelectable, copyTotals } from "@canopy/domain/workspace-copy";
import * as Crypto from "expo-crypto";
import { useSession } from "../../state/session";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [progress, setProgress] = useState<ui.WorkspaceCopyProgress>();
  const abort = useRef<AbortController | undefined>(undefined);
  const manifestToken = useRef("");
  const entries = useMemo(() => copySelection(manifest?.entries ?? [], selected), [manifest, selected]);
  const totals = useMemo(() => copyTotals(entries), [entries]);
  const repositoryBlocked = manifest?.entries.some((e) => !copySelectable(e) && e.blocked);
  const secrets = useMemo(() => entries.filter((e) => e.secret && !e.directory), [entries]);

  const skipped = useMemo(
    () => manifest?.entries.filter((e) => copySelectable(e) && !e.directory && !selected.has(e.path)).length ?? 0,
    [manifest, selected],
  );

  useEffect(
    () => () => {
      abort.current?.abort();

      void releaseCopy(client, props.workspace.id, manifestToken.current);
    },
    [client, props.workspace.id],
  );

  async function load() {
    if (!client) return;
    setLoading(true);
    setError("");
    setCancelled(false);
    setConfirming(false);
    setConfirmed(false);
    setProgress(undefined);

    try {
      await releaseCopy(client, props.workspace.id, manifestToken.current);

      const result = (
        await client.api.getWorkspaceCopyManifest({ workspaceId: props.workspace.id }, { timeoutMs: 130_000 })
      ).manifest;

      setManifest(result);
      manifestToken.current = result?.token ?? "";
      setSelected(new Set(result?.entries.filter((e) => copySelectable(e) && e.included).map((e) => e.path)));
    } catch (cause) {
      setError(copyMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!client || !manifest || busy) return;

    if (secrets.length && !confirmed) {
      setConfirming(true);

      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    props.onBusy(true);
    setError("");
    let finished = false;

    try {
      for await (const event of client.api.copyWorkspace(
        {
          sourceRef: props.workspace.id,
          targetRef: props.worker.id,
          projectRef: props.project.id,
          manifestToken: manifest.token,
          ignoredSelection: { paths: [...selected] },
          confirmedSecrets: confirmed ? secrets.map((e) => e.path) : [],
          parentPath: parent,
          name,
          transferKey: Crypto.randomUUID(),
        },
        { signal: controller.signal, timeoutMs: 60 * 60_000 },
      )) {
        setProgress(event);
        finished ||= event.status === "completed";
      }

      if (!finished) setError("The copy was interrupted. Refresh the file list and retry.");
    } catch (cause) {
      if (controller.signal.aborted) setCancelled(true);
      else setError(copyMessage(cause));
    } finally {
      setBusy(false);
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
    repositoryBlocked,
    secrets,
    skipped,
    load,
    copy,
    cancel: () => abort.current?.abort(),
  };
}

function copyMessage(cause: unknown) {
  return cause instanceof ConnectError ? cause.rawMessage : "Workspace copy failed. Check the connection and retry.";
}

async function releaseCopy(client: ReturnType<typeof useSession>["client"], workspaceId: string, token: string) {
  if (token)
    await client?.api.workspaceCopySource({ workspaceId, token, release: true }, { timeoutMs: 15_000 }).catch(() => {});
}

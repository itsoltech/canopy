import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import * as Crypto from "expo-crypto";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { clearDiagnosticLogs, exportDiagnosticLogs } from "./diagnostics-log-file";

export type DiagnosticsLogsModel = ReturnType<typeof useDiagnosticsLogs>;

function useLogPolling(
  job: ui.DiagnosticsLogsJob | undefined,
  setJob: Dispatch<SetStateAction<ui.DiagnosticsLogsJob | undefined>>,
  onReady: (id: string) => void,
  setError: (error: string) => void,
) {
  const { client } = useSession();
  useEffect(() => {
    if (!client || !job || job.status !== "collecting") return;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      void client.api
        .getDiagnosticsLogsJob({ jobId: job.jobId }, { signal: controller.signal })
        .then((value) => {
          setJob(value);

          if (["done", "partial"].includes(value.status)) onReady(value.jobId);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("Could not refresh the collection. Retry to check its progress.");
        });
    }, 1000);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, job, onReady, setJob, setError]);
}

export function useDiagnosticsLogs(onReady: (id: string) => void) {
  const { client } = useSession();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [hours, setHours] = useState("1");
  const [legacy, setLegacy] = useState(false);
  const [job, setJob] = useState<ui.DiagnosticsLogsJob>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [folder, setFolder] = useState("");
  const running = useRef(false);
  const abort = useRef(new AbortController());
  useLogPolling(job, setJob, onReady, setError);
  useEffect(() => {
    abort.current = new AbortController();
    clearDiagnosticLogs();

    return () => {
      abort.current.abort();
      clearDiagnosticLogs();
    };
  }, [client]);

  async function collect(selection = ids) {
    if (!client || running.current || !selection.length) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setFolder("");
    onReady("");

    try {
      setJob(
        await client.api.collectDiagnosticsLogs({
          computerIds: selection,
          hours: Number(hours),
          includeLegacy: legacy,
          aliasHome: true,
          actionId: Crypto.randomUUID(),
        }),
      );
    } catch {
      setError("Could not collect logs. Check the selection and retry.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function download() {
    if (!client || !job || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setFolder("");

    try {
      const result = await exportDiagnosticLogs(client.api, job, abort.current.signal);
      setMessage(result.message);
      setFolder(result.folder);
    } catch {
      if (!abort.current.signal.aborted) setError("Could not export logs. Try again or collect logs again.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (!client || !job || running.current) return;

    try {
      setJob(await client.api.cancelDiagnosticsLogs({ jobId: job.jobId }));
      onReady("");
    } catch {
      setError("Could not cancel the collection. Retry to check its progress.");
    }
  }

  async function refresh() {
    if (!client || !job) return;

    try {
      setError("");
      setJob(await client.api.getDiagnosticsLogsJob({ jobId: job.jobId }));
    } catch {
      setError("Could not refresh the collection. Collect logs again.");
    }
  }

  return {
    open,
    setOpen,
    ids,
    setIds,
    hours,
    setHours,
    legacy,
    setLegacy,
    job,
    busy,
    error,
    message,
    folder,
    setError,
    collect,
    download,
    cancel,
    refresh,
  };
}

import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import type { MessageDraft } from "../composer/useMessageDraft";
import { rewindDraft } from "./rewind-draft";

type Intent =
  | { action: "rewind"; turnId: string; clientRequestId: string; restoreFiles: boolean; stopRunning: boolean }
  | { action: "read" | "restore"; rewindId: string };

/** Retries retain the original intent and recover the durable result instead of rewinding twice. */
export function useThreadRewind(id: string, message: MessageDraft, sending: boolean, onReady: () => void) {
  const { client } = useSession();
  const [selected, setSelected] = useState<ui.Turn>();
  const [preview, setPreview] = useState<ui.ThreadRewindPreview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [saved, setSaved] = useState<ReturnType<MessageDraft["snapshot"]>[]>([]);
  const pending = useRef<Intent | undefined>(undefined);
  const lock = useRef(false);
  const generation = useRef(0);

  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;

    return () => controller.abort();
  }, [id]);

  async function open(turn: ui.Turn) {
    if (!client || sending || message.files.blocker || lock.current) {
      setError("Finish sending or uploading files before editing this message.");

      return;
    }

    const current = ++generation.current;
    const signal = lifetime.current.signal;
    setSelected(turn);
    setPreview(undefined);
    setError("");
    setCanRetry(false);
    setChecking(true);

    try {
      const value = await client.api.prepareThreadRewind(
        { threadId: id, turnId: turn.id },
        { timeoutMs: 35_000, signal },
      );

      if (generation.current === current && !signal.aborted) setPreview(value);
    } catch (cause) {
      if (generation.current === current && !signal.aborted) {
        setError(ConnectError.from(cause).rawMessage);
        setCanRetry(true);
      }
    } finally {
      if (generation.current === current && !signal.aborted) setChecking(false);
    }
  }

  async function run(intent: Intent) {
    if (!client || lock.current || sending || message.files.blocker) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setCanRetry(true);
    pending.current = intent;
    const signal = lifetime.current.signal;

    try {
      const result = await resolveRewind(client.api, id, intent, signal, (rewindId) => {
        pending.current = { action: "read", rewindId };
      });

      if (signal.aborted) return;

      if (["pending", "restoring"].includes(result.status))
        throw new Error("The agent is still editing this thread. Retry to check its progress.");

      if (result.error || result.status === "failed") {
        pending.current = undefined;
        setCanRetry(false);
        throw new Error(result.error || "Could not edit this thread. Choose the message again.");
      }

      if (result.status === "completed" && result.draft) {
        const before = message.snapshot();

        if (before.value.text || before.files.length || before.value.quotes?.length)
          setSaved((all) => [...all, before]);
        message.restore(rewindDraft(result.draft));
        onReady();
      }

      pending.current = undefined;
      setCanRetry(false);
      setSelected(undefined);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not reach the agent. Retry to check the result.");
    } finally {
      lock.current = false;

      if (!signal.aborted) setBusy(false);
    }
  }

  return {
    selected,
    preview,
    error,
    busy,
    checking,
    canRetry,
    saved: saved.length,
    open: (turn: ui.Turn) => void open(turn),
    close: () => {
      generation.current++;
      setSelected(undefined);
    },
    edit: (restoreFiles: boolean) =>
      selected &&
      preview &&
      void run({
        action: "rewind",
        turnId: selected.id,
        restoreFiles,
        stopRunning: preview.running,
        clientRequestId: Crypto.randomUUID(),
      }),
    restore: (rewindId: string) => void run({ action: "restore", rewindId }),
    recover: (rewindId: string) => void run({ action: "read", rewindId }),
    retry: () => (pending.current ? void run(pending.current) : selected && void open(selected)),
    swap: () => {
      const first = saved[0];

      if (!first || sending || message.files.blocker || lock.current) return;
      setSaved([...saved.slice(1), message.snapshot()]);
      message.restore(first);
      onReady();
    },
  };
}

/** Poll the durable operation; losing the response must not create a second rewind. */
async function resolveRewind(
  api: NonNullable<ReturnType<typeof useSession>["client"]>["api"],
  threadId: string,
  intent: Intent,
  signal: AbortSignal,
  started: (rewindId: string) => void,
) {
  const options = { timeoutMs: 35_000, signal };

  let result =
    intent.action === "rewind"
      ? await api.rewindThread({ threadId, ...intent }, options)
      : intent.action === "restore"
        ? await api.restoreThreadRewind({ threadId, rewindId: intent.rewindId }, options)
        : await api.getThreadRewind({ threadId, rewindId: intent.rewindId }, options);

  if (signal.aborted) return result;
  started(result.rewindId);

  for (let attempt = 0; ["pending", "restoring"].includes(result.status) && attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (signal.aborted) break;
    result = await api.getThreadRewind({ threadId, rewindId: result.rewindId }, options);
  }

  return result;
}

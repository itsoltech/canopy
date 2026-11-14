import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import type { ComposerConnection } from "@canopy/domain/composer-connection";
import type { ComposerPick } from "@canopy/domain/composer-choices";
import type { MessageDraft } from "../composer/useMessageDraft";
import type { useQuoteDraft } from "../quotes/useQuoteDraft";
import { useSession } from "../../state/session";
import { withSentMessage } from "./sent-message";
import { confirmMessage, uncertainDelivery } from "./pending-message";

/** The gateway refused the message; other failures leave delivery uncertain. */
function deliveryError(failure: ConnectError) {
  return [Code.InvalidArgument, Code.FailedPrecondition, Code.ResourceExhausted].includes(failure.code)
    ? failure.rawMessage
    : "Could not confirm delivery. Retry with the same text to send it only once.";
}

export function useThreadSend(options: {
  id: string;
  message: MessageDraft;
  quotes: ReturnType<typeof useQuoteDraft>;
  connection: ComposerConnection;
  setSnapshot: (update: (previous: ui.ThreadSnapshot | undefined) => ui.ThreadSnapshot | undefined) => void;
  onSend: () => void;
}) {
  const { client, session, expired } = useSession();
  const { id, message, quotes, connection, setSnapshot } = options;
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const controller = useRef(new AbortController());
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    sending.current = false;
    setBusy(false);

    return () => request.abort();
  }, [id, session?.deviceId]);

  async function send(delivery: ui.MessageDelivery, choices?: ComposerPick) {
    const { text: value, attachmentIds, mentions, quotes: sentQuotes } = message.outgoing();

    if (
      !client ||
      !connection.composerAvailable ||
      (!value && !attachmentIds.length && !quotes.quotes.length) ||
      message.files.blocker ||
      message.persistent?.preparing ||
      sending.current
    )
      return;
    sending.current = true;
    options.onSend();
    setBusy(true);
    setWaiting(!connection.live);
    setError("");
    const key = JSON.stringify({ value, delivery, attachmentIds, mentions, quotes: sentQuotes, choices });

    if (pending.current?.key !== key)
      pending.current = { key, id: message.persistent?.requestId ?? Crypto.randomUUID() };
    const attempt = new AbortController();
    const view = controller.current;
    const signal = attempt.signal;
    const api = client.api;

    if (message.persistent) message.persistent.pendingAbort = () => attempt.abort();
    let outgoingRequestId = message.persistent?.requestId;

    if (message.persistent) message.persistent.preparing = true;

    try {
      let request = message.persistent?.pendingSend;

      if (!request) {
        const published = await message.persistent?.publishForSend();
        request = create(ui.SendMessageRequestSchema, {
          draftId: published?.id ?? "",
          draftRevision: published?.revision ?? 0n,
          threadId: id,
          text: value,
          delivery,
          attachmentIds,
          mentions,
          quotes: sentQuotes,
          clientRequestId: message.persistent?.requestId ?? pending.current.id,
          ...choices,
        });
        await message.persistent?.beginSend(request);
      }

      outgoingRequestId = request.clientRequestId;

      const result = await confirmMessage(
        request,
        () => api,
        signal,
        () => setWaiting(true),
      );

      if (!message.persistent || message.persistent.requestId === outgoingRequestId) message.clear();

      if (signal.aborted || view.signal.aborted) return;
      setSnapshot((snapshot) => withSentMessage(snapshot, result));
      quotes.clear();

      if (result.deliveryNote) setError(result.deliveryNote);
      pending.current = null;
    } catch (e) {
      const canceled = signal.aborted || view.signal.aborted;

      if (!uncertainDelivery(e)) {
        const code = ConnectError.from(e).code;
        message.persistent?.cancelSend([Code.NotFound, Code.FailedPrecondition].includes(code));
        pending.current = null;
      }

      if (ConnectError.from(e).code === Code.Unauthenticated) await expired();
      else if (!canceled) setError(deliveryError(ConnectError.from(e)));
    } finally {
      if (message.persistent) {
        message.persistent.preparing = false;
        message.persistent.pendingAbort = undefined;
        message.persistent.persist();
        void message.persistent.reconcile(api);
      }

      if (!view.signal.aborted) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  return { send, busy, waiting, error, setError };
}

import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { ComposerConnection } from "@canopy/domain/composer-connection";
import type { ComposerPick } from "@canopy/domain/composer-choices";
import type { MessageDraft } from "../composer/useMessageDraft";
import type { useQuoteDraft } from "../quotes/useQuoteDraft";
import { useSession } from "../../state/session";
import { withSentMessage } from "./sent-message";
import { confirmMessage } from "./pending-message";

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
  const currentClient = useRef(client);
  currentClient.current = client;
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;

    return () => request.abort();
  }, [id, session?.deviceId]);

  async function send(delivery: ui.MessageDelivery, choices?: ComposerPick) {
    const { text: value, attachmentIds, mentions, quotes: sentQuotes } = message.outgoing();

    if (
      !client ||
      !connection.composerAvailable ||
      (!value && !attachmentIds.length && !quotes.quotes.length) ||
      message.files.blocker ||
      sending.current
    )
      return;
    sending.current = true;
    options.onSend();
    setBusy(true);
    setWaiting(!connection.live);
    setError("");
    const key = JSON.stringify({ value, delivery, attachmentIds, mentions, quotes: sentQuotes, choices });

    if (pending.current?.key !== key) pending.current = { key, id: Crypto.randomUUID() };
    const signal = controller.current.signal;

    try {
      const request = {
        threadId: id,
        text: value,
        delivery,
        attachmentIds,
        mentions,
        quotes: sentQuotes,
        clientRequestId: pending.current.id,
        ...choices,
      };

      const result = await confirmMessage(
        request,
        () => currentClient.current?.api,
        signal,
        () => setWaiting(true),
        () => connection.waitUntilLive(signal),
      );

      if (signal.aborted) return;
      setSnapshot((snapshot) => withSentMessage(snapshot, result));
      message.clear();
      quotes.clear();

      if (result.deliveryNote) setError(result.deliveryNote);
      pending.current = null;
    } catch (e) {
      if (ConnectError.from(e).code === Code.Unauthenticated) await expired();
      else if (!signal.aborted) setError(deliveryError(ConnectError.from(e)));
    } finally {
      sending.current = false;

      if (!signal.aborted) setBusy(false);
    }
  }

  return { send, busy, waiting, error, setError };
}

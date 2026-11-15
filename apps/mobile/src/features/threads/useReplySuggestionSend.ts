import { useEffect, useRef, useState, type RefObject } from "react";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import type { ComposerConnection } from "@canopy/domain/composer-connection";
import { useSession } from "../../state/session";
import { confirmMessage, uncertainDelivery } from "./pending-message";
import { withSentMessage } from "./sent-message";

export interface ReplySendOptions {
  id: string;
  sourceId?: string;
  connection: ComposerConnection;
  sendingRef: RefObject<boolean>;
  lifetime: RefObject<AbortController>;
  draftLocked: () => boolean;
  onSend: () => void;
  setBusy: (value: boolean) => void;
  setWaiting: (value: boolean) => void;
  setError: (value: string) => void;
  setSnapshot: (update: (previous: ui.ThreadSnapshot | undefined) => ui.ThreadSnapshot | undefined) => void;
}

/** A reply owns its immutable request and never borrows or clears the composer's draft. */
export function useReplySuggestionSend(options: ReplySendOptions) {
  const { client, session, expired } = useSession();
  const { sourceId, connection, sendingRef, lifetime, setBusy, setWaiting, setError, setSnapshot } = options;
  const scope = `${session?.deviceId}:${options.id}`;
  const pending = useRef<ui.SendMessageRequest | undefined>(undefined);
  const [unconfirmed, setUnconfirmed] = useState({ scope, value: false });
  const [invalid, setInvalid] = useState<{ scope: string; ids: ReadonlySet<string> }>({ scope, ids: new Set() });
  const invalidIds = useRef(new Set<string>());
  useEffect(() => {
    pending.current = undefined;
    invalidIds.current.clear();
  }, [scope]);

  function invalidate() {
    if (!sourceId) return;
    invalidIds.current.add(sourceId);
    setInvalid({ scope, ids: new Set(invalidIds.current) });
  }

  async function deliver(request: ui.SendMessageRequest) {
    if (!client || sendingRef.current || !connection.live || options.draftLocked()) return;
    sendingRef.current = true;
    const view = lifetime.current;
    pending.current = request;
    setUnconfirmed({ scope, value: false });
    setBusy(true);
    setWaiting(false);
    setError("");
    options.onSend();

    try {
      const result = await confirmMessage(
        request,
        () => client.api,
        view.signal,
        () => setWaiting(true),
      );

      if (view.signal.aborted) return;
      pending.current = undefined;
      setSnapshot((snapshot) => withSentMessage(snapshot, result));

      if (result.deliveryNote) setError(result.deliveryNote);
    } catch (cause) {
      if (view.signal.aborted) return;

      if (uncertainDelivery(cause)) {
        setUnconfirmed({ scope, value: true });
        setError("Could not confirm delivery. Retry to check whether the reply was sent.");
      } else {
        pending.current = undefined;
        const code = ConnectError.from(cause).code;

        if (code === Code.Unauthenticated) await expired();
        else
          setError(
            code === Code.FailedPrecondition
              ? "This reply is no longer available. Write a message to continue."
              : "Could not send this reply. Check the connection, then write a message.",
          );
      }
    } finally {
      if (!view.signal.aborted) {
        sendingRef.current = false;
        setBusy(false);
      }
    }
  }

  function send(itemId: string, text: string) {
    if (itemId !== sourceId || invalidIds.current.has(itemId) || pending.current || sendingRef.current) return;

    if (!client || !connection.live || options.draftLocked()) return;
    invalidate();
    void deliver(
      create(ui.SendMessageRequestSchema, {
        threadId: options.id,
        text,
        replySuggestionItemId: itemId,
        clientRequestId: Crypto.randomUUID(),
        delivery: ui.MessageDelivery.QUEUE,
      }),
    );
  }

  return {
    send,
    invalidate,
    activeId: sourceId && !(invalid.scope === scope && invalid.ids.has(sourceId)) ? sourceId : undefined,
    unconfirmed: unconfirmed.scope === scope && unconfirmed.value,
    retry: () => {
      if (pending.current) void deliver(pending.current);
    },
  };
}

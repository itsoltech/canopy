import { useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import * as Crypto from "expo-crypto";
import type { github } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { mutationRequest, sendMutation } from "@canopy/domain/github-mutations";
import { useSession } from "../../state/session";

export const mutationRefused = (cause: unknown) =>
  [
    Code.InvalidArgument,
    Code.Unauthenticated,
    Code.PermissionDenied,
    Code.NotFound,
    Code.AlreadyExists,
    Code.Aborted,
    Code.FailedPrecondition,
    Code.ResourceExhausted,
  ].includes(ConnectError.from(cause).code);

export function useMutation(snapshot: github.PullRequestSnapshot, initial?: github.PullRequestMutationReceipt) {
  const { client, online } = useSession();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<github.PullRequestMutationReceipt | undefined>(initial);

  async function send(
    action: string,
    fields: MessageInitShape<typeof github.PullRequestMutationRequestSchema> = {},
    prepared?: github.PullRequestMutationRequest,
  ) {
    if (!client || !online || locked.current || snapshot.stale) return;
    locked.current = true;
    setBusy(true);

    try {
      const request = prepared ?? mutationRequest(snapshot, Crypto.randomUUID(), action, fields);

      const result = await sendMutation(
        client.api,
        request,
        mutationRefused,
        (cause) => ConnectError.from(cause).rawMessage,
      );

      setReceipt(result);

      return result;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return { send, receipt, busy, online, client, clear: () => setReceipt(undefined) };
}

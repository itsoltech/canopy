import { useCallback, useState } from "react";
import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { usePullRequestWatch } from "./usePullRequestWatch";

export const deniedRead = (code: Code) =>
  [Code.PermissionDenied, Code.NotFound, Code.FailedPrecondition, Code.Aborted].includes(code);

export const accountAccessError = (cause: unknown) => {
  const error = ConnectError.from(cause);

  return error.code === Code.PermissionDenied ? error.rawMessage : "";
};

export function usePullRequestRead(id: string) {
  const { client, queries } = useSession();
  const key = `GetPullRequest:${id}`;
  const [denied, setDenied] = useState(false);
  const [accessError, setAccessError] = useState("");

  const onUpdate = useCallback(
    (update: github.PullRequestUpdate) => {
      if (update.snapshot) queries.set(key, update.snapshot);
    },
    [queries, key],
  );

  usePullRequestWatch(id, onUpdate);

  const read = useSharedQuery<github.PullRequestSnapshot>(
    key,
    async () => {
      try {
        const value = await client!.api.getPullRequest({ pullRequestId: id });
        setDenied(false);
        setAccessError("");

        return value;
      } catch (cause) {
        setAccessError(accountAccessError(cause));

        if (deniedRead(ConnectError.from(cause).code)) setDenied(true);
        throw cause;
      }
    },
    !!client,
    60_000,
  );

  return { read, denied, setDenied, accessError, setAccessError };
}

import { useMemo, useSyncExternalStore } from "react";
import * as Crypto from "expo-crypto";
import { ConnectError } from "@connectrpc/connect";
import type { github } from "@canopy/contracts";
import { GitHubCiController, type CiState } from "@canopy/domain/github-ci";
import { useSession } from "../../state/session";
import { mutationRefused } from "./useMutation";

const controllers = new WeakMap<object, Map<string, GitHubCiController>>();
const idle: CiState = { busy: false, open: false, jobId: "", jobName: "", action: "all", detail: "" };
const subscribeIdle = () => () => {};
const readIdle = () => idle;

export function useCiController(snapshot: github.PullRequestSnapshot, runId: string) {
  const { client, online } = useSession();

  const controller = useMemo(() => {
    if (!client) return undefined;
    let cache = controllers.get(client.api);

    if (!cache) {
      cache = new Map();
      controllers.set(client.api, cache);
    }

    const key = `${snapshot.accountId}:${snapshot.accessRevision}:${snapshot.summary?.ref?.id}:${runId}`;
    let value = cache.get(key);

    if (!value) {
      value = new GitHubCiController(
        client.api,
        snapshot,
        runId,
        Crypto.randomUUID,
        mutationRefused,
        (cause) => ConnectError.from(cause).rawMessage,
      );
      cache.set(key, value);

      if (cache.size > 100) cache.delete(cache.keys().next().value ?? "");
    }

    value.snapshot = snapshot;

    return value;
  }, [client, snapshot, runId]);

  const state = useSyncExternalStore(controller?.subscribe ?? subscribeIdle, controller?.read ?? readIdle);

  return { controller, state, online };
}

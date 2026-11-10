import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as Crypto from "expo-crypto";
import { ConnectError } from "@connectrpc/connect";
import type { github } from "@canopy/contracts";
import { GitHubMetadataEditor, type MetadataKind, type MetadataState } from "@canopy/domain/github-metadata";
import { useSession } from "../../state/session";
import { mutationRefused } from "./useMutation";

const editors = new WeakMap<object, Map<string, GitHubMetadataEditor>>();

const idle: MetadataState = {
  busy: false,
  title: "",
  body: "",
  ids: [],
  reviewerAction: "request",
  options: [],
  next: "",
  detail: "",
};

const noopSubscribe = () => () => {};
const readIdle = () => idle;

export function useMetadataEditor(snapshot: github.PullRequestSnapshot, kind: MetadataKind) {
  const { client, online } = useSession();

  const account = snapshot.accountId,
    revision = snapshot.accessRevision,
    pr = snapshot.summary?.ref?.id;

  const editor = useMemo(() => {
    if (!client) return undefined;
    let cache = editors.get(client.api);

    if (!cache) {
      cache = new Map();
      editors.set(client.api, cache);
    }

    const key = `${account}:${revision}:${pr}:${kind}`;
    let value = cache.get(key);

    if (!value) {
      value = new GitHubMetadataEditor(
        kind,
        client.api,
        snapshot,
        Crypto.randomUUID,
        mutationRefused,
        (cause) => ConnectError.from(cause).rawMessage,
      );
      cache.set(key, value);

      if (cache.size > 100) cache.delete(cache.keys().next().value ?? "");
    }

    return value;
  }, [client, account, revision, pr, kind, snapshot]);

  const state = useSyncExternalStore(editor?.subscribe ?? noopSubscribe, editor?.read ?? readIdle);
  useEffect(() => {
    editor?.acceptSnapshot(snapshot);
  }, [editor, snapshot]);

  return { editor, state, online, blocked: !online || snapshot.stale || !editor || editor.blocked };
}

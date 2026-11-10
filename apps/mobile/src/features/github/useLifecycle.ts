import { useState } from "react";
import * as Crypto from "expo-crypto";
import { ConnectError } from "@connectrpc/connect";
import type { github } from "@canopy/contracts";
import { lifecycleFields } from "@canopy/domain/github-lifecycle";
import { mutationRequest, mutationUnconfirmed } from "@canopy/domain/github-mutations";
import { useMutation } from "./useMutation";
import { commentDrafts } from "./comment-drafts";

export function useLifecycle(snapshot: github.PullRequestSnapshot, onrefresh: () => void) {
  const [key] = useState(() => commentDrafts.key(snapshot, "", "lifecycle"));
  const m = useMutation(snapshot, commentDrafts.read(key, "").receipt);

  const [action, setAction] = useState(""),
    [method, setMethod] = useState(""),
    [title, setTitle] = useState(""),
    [body, setBody] = useState("");

  const [prepared, setPrepared] = useState<github.PullRequestMutationRequest>();

  const [busy, setBusy] = useState(false),
    [picker, setPicker] = useState(false),
    [error, setError] = useState("");

  const life = snapshot.lifecycle,
    actions = life?.actions ?? [];

  const pending = !!m.receipt && (mutationUnconfirmed(m.receipt) || m.receipt.state === "accepted");
  const blocked = busy || m.busy || !m.online || snapshot.stale || pending;

  const primary = actions.includes("ready")
    ? "ready"
    : life?.inQueue
      ? "dequeue"
      : life?.queueRequired
        ? "enqueue"
        : "merge";

  const methods = action === "update_branch" ? (life?.updateMethods ?? []) : (life?.mergeMethods ?? []);

  function choose(value: string, selected?: string) {
    setAction(value);
    setMethod(selected ?? (value === "update_branch" ? life?.updateMethods : life?.mergeMethods)?.[0] ?? "");
    setTitle(life?.mergeTitle ?? snapshot.summary?.title ?? "");
    setBody(life?.mergeBody ?? "");
    setPrepared(undefined);
    setError("");
  }

  async function confirm() {
    if (!m.client || blocked) return;
    setBusy(true);
    setError("");

    try {
      if (!prepared) {
        const fields = lifecycleFields(action);
        const r = mutationRequest(snapshot, Crypto.randomUUID(), fields.action, { ...fields, method, title, body });
        const p = await m.client.api.preparePullRequestMutation(r);
        setPrepared({ ...r, confirmationId: p.confirmationId });
      } else {
        commentDrafts.pending(key, "", prepared);
        const receipt = await m.send(prepared.action, {}, prepared);
        commentDrafts.save(key, "", receipt);
        setAction("");
        setPrepared(undefined);
        onrefresh();
      }
    } catch (cause) {
      setError(ConnectError.from(cause).rawMessage);
      setPrepared(undefined);
    } finally {
      setBusy(false);
    }
  }

  function check() {
    m.clear();
    commentDrafts.save(key, "");
    onrefresh();
  }

  const change = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPrepared(undefined);
  };

  return {
    action,
    method,
    title,
    body,
    prepared,
    busy,
    picker,
    setPicker,
    error,
    life,
    actions,
    pending,
    blocked,
    primary,
    methods,
    choose,
    confirm,
    check,
    receipt: m.receipt,
    online: m.online,
    changeTitle: change(setTitle),
    changeBody: change(setBody),
    changeMethod: change(setMethod),
    close: () => {
      if (!busy) setAction("");
    },
  };
}

export type LifecycleForm = ReturnType<typeof useLifecycle>;

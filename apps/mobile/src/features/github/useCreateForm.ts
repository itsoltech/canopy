import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
import { ConnectError } from "@connectrpc/connect";
import { createRequest } from "@canopy/domain/github-lifecycle";
import { draftPullRequest } from "@canopy/domain/github-agent-draft";
import { sendMutation, mutationUnconfirmed } from "@canopy/domain/github-mutations";
import { useSession } from "../../state/session";
import { mutationRefused } from "./useMutation";
import { createDrafts } from "./create-drafts";

type ContextFields = MessageInitShape<typeof github.PullRequestCreateContextRequestSchema>;

export interface CreateProps {
  threadId: string;
  visible: boolean;
  onClose: () => void;
  oncreated: () => void;
  ondrafted: () => void;
}

export function useCreateForm(props: CreateProps) {
  const { threadId, visible } = props;
  const { client, online } = useSession();

  const locked = useRef(false),
    started = useRef(false);

  const draftingRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => draftingRequest.current?.abort(), []);

  const [initial] = useState(() => createDrafts.read(threadId));

  const [context, setContext] = useState<github.PullRequestCreateContext>(),
    [selection, setSelection] = useState<github.GitHubRepositoryAccountResponse>();

  const [title, setTitle] = useState(initial.title),
    [body, setBody] = useState(initial.body);

  const [draft, setDraft] = useState(initial.draft),
    [consent, setConsent] = useState(initial.consent);

  const [busy, setBusy] = useState(false),
    [drafting, setDrafting] = useState(false),
    [error, setError] = useState(""),
    [picker, setPicker] = useState("");

  const [prepared, setPrepared] = useState<github.PullRequestMutationRequest>(),
    [receipt, setReceipt] = useState(initial.receipt);

  const homeId = splitId(threadId).node ? `${GITHUB_HOME}~${splitId(threadId).node}` : "";
  const uncertain = !!receipt && (mutationUnconfirmed(receipt) || receipt.state === "accepted");
  const blocked =
    busy || !online || uncertain || !context?.published || !context.accountId || !context.headRef || !context.baseRef;

  const request = (fields: ContextFields = {}) =>
    create(github.PullRequestCreateContextRequestSchema, {
      threadId,
      repositoryName: context?.repositoryName,
      baseRef: context?.baseRef,
      ...fields,
    });

  const savePending = (r: github.PullRequestMutationRequest) =>
    pendingCreate(threadId, { title, body, draft, consent }, r);

  useEffect(() => {
    createDrafts.save(threadId, { title, body, draft, consent, receipt });
  }, [threadId, title, body, draft, consent, receipt]);

  const change =
    <T>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPrepared(undefined);
    };

  const lock = () => {
    if (locked.current) return false;
    locked.current = true;

    return true;
  };

  const unlock = () => {
    locked.current = false;
  };

  async function load(fields: ContextFields = {}) {
    if (!client || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setPrepared(undefined);

    try {
      const value = await client.api.getPullRequestCreateContext(request(fields));
      setContext(value);
      setSelection(await client.api.getGitHubRepositoryAccount({ homeId, repositoryName: value.repositoryName }));
    } catch (cause) {
      setError(ConnectError.from(cause).rawMessage);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!visible) started.current = false;
    else if (!started.current) {
      started.current = true;
      void load();
    }
  });

  const state = {
    ...props,
    client,
    online,
    lock,
    unlock,
    context,
    setContext,
    selection,
    title,
    setTitle: change(setTitle),
    body,
    setBody: change(setBody),
    draft,
    setDraft: change(setDraft),
    consent,
    setConsent: change(setConsent),
    drafting,
    setDrafting,
    draftingRequest,
    busy,
    setBusy,
    error,
    setError,
    picker,
    setPicker,
    prepared,
    setPrepared,
    receipt,
    setReceipt,
    homeId,
    uncertain,
    blocked,
    request,
    savePending,
    load,
  };

  return { ...state, ...useCreateOperations(state) };
}

interface CreateState {
  client: ReturnType<typeof useSession>["client"];
  context: github.PullRequestCreateContext | undefined;
  selection: github.GitHubRepositoryAccountResponse | undefined;
  receipt: github.PullRequestMutationReceipt | undefined;
  prepared: github.PullRequestMutationRequest | undefined;
  lock: () => boolean;
  unlock: () => void;
  blocked: boolean;
  threadId: string;
  homeId: string;
  title: string;
  body: string;
  draft: boolean;
  consent: boolean;
  picker: string;
  setDrafting: (v: boolean) => void;
  draftingRequest: { current: AbortController | undefined };
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  setPrepared: (v: github.PullRequestMutationRequest | undefined) => void;
  setReceipt: (v: github.PullRequestMutationReceipt | undefined) => void;
  setContext: (v: github.PullRequestCreateContext) => void;
  setTitle: (v: string) => void;
  setBody: (v: string) => void;
  savePending: (r: github.PullRequestMutationRequest) => void;
  request: (fields?: ContextFields) => github.PullRequestCreateContextRequest;
  load: (fields?: ContextFields) => Promise<void>;
  onClose: () => void;
  oncreated: () => void;
  ondrafted: () => void;
}

function useCreateOperations(f: CreateState) {
  const finish = (result: github.PullRequestMutationReceipt) => {
    createDrafts.save(f.threadId, {
      title: f.title,
      body: f.body,
      draft: f.draft,
      consent: f.consent,
      receipt: result,
    });
    f.setReceipt(result);

    if (result.state === "succeeded") {
      f.onClose();
      f.oncreated();
    }
  };

  return {
    agentDraft: () =>
      createAction(f, async () => {
        if (!f.client || !f.context || f.blocked) return;
        const controller = new AbortController();
        f.draftingRequest.current = controller;
        f.setDrafting(true);

        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);

          const context = await f.client.api.preparePullRequestDraftContext(f.request({ headSha: f.context.headSha }), {
            signal,
          });

          const proposal = await draftPullRequest(f.client.api, f.threadId, context, Crypto.randomUUID(), signal);
          f.setTitle(proposal.title);
          f.setBody(proposal.body);
        } catch {
          f.setError("Draft was not returned. Check the thread before drafting again.");
        } finally {
          f.setDrafting(false);
          f.draftingRequest.current = undefined;
        }
      }),
    submit: () =>
      createAction(f, async () => {
        if (!f.client || !f.context || f.blocked) return;

        if (!f.prepared) {
          const r = createRequest(f.context, Crypto.randomUUID(), f.title, f.body, f.draft, f.consent);
          const p = await f.client.api.preparePullRequestMutation(r);
          f.setPrepared({ ...r, confirmationId: p.confirmationId });
        } else {
          f.savePending(f.prepared);

          const result = await sendMutation(
            f.client.api,
            f.prepared,
            mutationRefused,
            (cause) => ConnectError.from(cause).rawMessage,
          );

          finish(result);

          if (result.state === "failed") f.setPrepared(undefined);
        }
      }),
    reconcile: () =>
      createAction(f, async () => {
        if (f.client && f.receipt)
          finish(
            await f.client.api.getPullRequestMutation({
              threadId: f.threadId,
              clientRequestId: f.receipt.clientRequestId,
            }),
          );
      }),
    linkExisting: () =>
      createAction(f, async () => {
        const ref = f.receipt?.existingPullRequest;

        if (!f.client || !ref) return;
        const links = await f.client.api.listThreadPullRequests({ threadId: f.threadId });
        await f.client.api.linkThreadPullRequest({
          threadId: f.threadId,
          url: `https://github.com/${ref.repositoryName}/pull/${ref.number}`,
          expectedRevision: links.revision,
        });
        createDrafts.save(f.threadId, { title: f.title, body: f.body, draft: f.draft, consent: f.consent });
        f.setReceipt(undefined);
        f.onClose();
        f.oncreated();
      }),
    choose: async (value: string) => {
      try {
        if (f.picker === "account" && f.selection && f.client && f.context)
          await f.client.api.setGitHubRepositoryAccount({
            homeId: f.homeId,
            repositoryName: f.context.repositoryName,
            accountId: value,
            expectedRevision: f.selection.revision,
          });
        await f.load(
          f.picker === "base"
            ? { baseRef: value }
            : f.picker === "repository"
              ? { repositoryName: value, baseRef: "" }
              : {},
        );
      } catch (cause) {
        f.setError(ConnectError.from(cause).rawMessage);
      }
    },
    more: () =>
      createAction(f, async () => {
        if (!f.client || !f.context) return;
        const more = await f.client.api.getPullRequestCreateContext(f.request({ cursor: f.context.nextCursor }));
        f.setContext({
          ...f.context,
          branches: [...f.context.branches, ...more.branches],
          nextCursor: more.nextCursor,
        });
      }),
  };
}

async function createAction(
  f: Pick<CreateState, "lock" | "unlock" | "setBusy" | "setError" | "setPrepared">,
  action: () => Promise<void>,
) {
  if (!f.lock()) return;
  f.setBusy(true);
  f.setError("");

  try {
    await action();
  } catch (cause) {
    f.setError(ConnectError.from(cause).rawMessage);
    f.setPrepared(undefined);
  } finally {
    f.unlock();
    f.setBusy(false);
  }
}

export type CreateForm = ReturnType<typeof useCreateForm>;

function pendingCreate(
  thread: string,
  text: { title: string; body: string; draft: boolean; consent: boolean },
  r: github.PullRequestMutationRequest,
) {
  createDrafts.save(thread, {
    ...text,
    receipt: create(github.PullRequestMutationReceiptSchema, {
      clientRequestId: r.clientRequestId,
      action: "create_pr",
      state: "in_flight",
    }),
  });
}

<script lang="ts">
  import { untrack } from "svelte";
  import { create, type MessageInitShape } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import { createRequest, importPullRequestDraft } from "@canopy/domain/github-lifecycle";
  import { sendMutation, mutationUnconfirmed } from "@canopy/domain/github-mutations";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { contextDraft } from "./context-draft.svelte.ts";
  import { createDrafts } from "./create-drafts.ts";
  import { mutationRefused, mutationDetail } from "./mutation-errors.ts";
  import * as api from "./api.ts";

  let {
    threadId,
    open = $bindable(false),
    oncreated,
  }: { threadId: string; open?: boolean; oncreated: () => void } = $props();

  let context = $state<github.PullRequestCreateContext>();
  let selection = $state<github.GitHubRepositoryAccountResponse>();

  const initial = untrack(() => createDrafts.read(threadId));

  let title = $state(initial.title),
    body = $state(initial.body),
    imported = $state(""),
    draft = $state(initial.draft),
    consent = $state(initial.consent),
    preview = $state(false);

  let busy = $state(false),
    error = $state(""),
    online = $state(true);

  let prepared = $state<github.PullRequestMutationRequest>();
  let receipt = $state<github.PullRequestMutationReceipt | undefined>(initial.receipt);

  $effect(() => createDrafts.save(threadId, { title, body, draft, consent, receipt }));

  const homeId = $derived(splitId(threadId).node ? `${GITHUB_HOME}~${splitId(threadId).node}` : "");
  const uncertain = $derived(!!receipt && (mutationUnconfirmed(receipt) || receipt.state === "accepted"));
  const blocked = $derived(busy || !online || uncertain || !context?.published || !context.accountId);

  const request = (fields: MessageInitShape<typeof github.PullRequestCreateContextRequestSchema> = {}) =>
    create(github.PullRequestCreateContextRequestSchema, {
      threadId,
      repositoryName: context?.repositoryName,
      baseRef: context?.baseRef,
      ...fields,
    });

  $effect(() => {
    if (open && !context) untrack(() => void load());
  });

  $effect(() => {
    const change = () => (online = navigator.onLine);
    change();
    window.addEventListener("online", change);
    window.addEventListener("offline", change);

    return () => {
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
    };
  });

  $effect(() => {
    if (
      prepared &&
      (prepared.title !== title ||
        prepared.body !== body ||
        prepared.draft !== draft ||
        prepared.maintainerCanModify !== consent)
    )
      prepared = undefined;
  });

  async function load(fields: MessageInitShape<typeof github.PullRequestCreateContextRequestSchema> = {}) {
    if (busy) return;
    busy = true;
    error = "";
    prepared = undefined;

    try {
      context = await api.createContext(request(fields));
      selection = await api.repositoryAccount(homeId, context.repositoryName);
    } catch (cause) {
      error = mutationDetail(cause) || "Could not check this branch. Check GitHub access, then retry.";
    } finally {
      busy = false;
    }
  }

  async function account(value: string) {
    if (!selection || !context) return;

    try {
      await api.chooseAccount(homeId, context.repositoryName, value, selection.revision);
      await load();
    } catch (cause) {
      error = mutationDetail(cause);
    }
  }

  async function agentDraft() {
    if (!context || blocked) return;
    busy = true;
    error = "";

    try {
      contextDraft.pending = { threadId, context: await api.draftContext(request({ headSha: context.headSha })) };
      open = false;
    } catch (cause) {
      error = mutationDetail(cause);
    } finally {
      busy = false;
    }
  }

  function useDraft() {
    try {
      const value = importPullRequestDraft(imported);
      title = value.title;
      body = value.body;
      imported = "";
      error = "";
    } catch {
      error = "Paste the agent’s JSON with a title and body, then review both fields.";
    }
  }

  async function submit() {
    if (!context || blocked || !title.trim()) return;
    busy = true;
    error = "";

    try {
      if (!prepared) {
        const r = createRequest(context, crypto.randomUUID(), title, body, draft, consent);
        const p = await api.mutations.preparePullRequestMutation(r);
        prepared = { ...r, confirmationId: p.confirmationId };
      } else {
        createDrafts.save(threadId, {
          title,
          body,
          draft,
          consent,
          receipt: create(github.PullRequestMutationReceiptSchema, {
            clientRequestId: prepared.clientRequestId,
            action: "create_pr",
            state: "in_flight",
          }),
        });
        receipt = await sendMutation(api.mutations, prepared, mutationRefused, mutationDetail);

        if (receipt.state === "succeeded") {
          open = false;
          oncreated();
        } else if (receipt.state === "failed") prepared = undefined;
      }
    } catch (cause) {
      error = mutationDetail(cause);
      prepared = undefined;
    } finally {
      busy = false;
    }
  }

  async function reconcile() {
    if (!receipt) return;
    busy = true;

    try {
      receipt = await api.mutations.getPullRequestMutation({
        $typeName: "canopy.ui.v1.PullRequestMutationRequestRef",
        pullRequestId: "",
        threadId,
        clientRequestId: receipt.clientRequestId,
        clientBinding: "",
      });

      if (receipt.state === "succeeded") {
        open = false;
        oncreated();
      }
    } catch (cause) {
      error = mutationDetail(cause);
    } finally {
      busy = false;
    }
  }

  async function linkExisting() {
    const ref = receipt?.existingPullRequest;

    if (!ref || busy || !online) return;
    busy = true;

    try {
      const links = await api.pullRequests(threadId);
      await api.link(threadId, `https://github.com/${ref.repositoryName}/pull/${ref.number}`, links.revision);
      createDrafts.save(threadId, { title, body, draft, consent });
      receipt = undefined;
      open = false;
      oncreated();
    } catch (cause) {
      error = mutationDetail(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Create pull request" size="lg" fullscreen dismissible={!busy}>
  <div class="grid min-w-0 gap-3">
    {#if context}
      <p class="text-sm break-words text-zinc-500 dark:text-zinc-400">
        {context.viewerLogin} · {context.headRepositoryName}:{context.headRef} ·
        <span title={context.headSha}>{context.headSha.slice(0, 7)}</span>
      </p>
      <Select
        aria-label="Base repository"
        value={context.repositoryName}
        options={context.repositories.map((value) => ({ value, label: value }))}
        disabled={busy || uncertain}
        onchange={(repositoryName) => void load({ repositoryName, baseRef: "" })}
      />
      {#if selection}<Select
          aria-label="GitHub account"
          value={context.accountId}
          options={selection.candidates.map((a) => ({ value: a.id, label: a.login }))}
          disabled={busy || uncertain}
          onchange={(value) => void account(value)}
        />{/if}
      {#if context.accountId}<Select
          aria-label="Base branch"
          value={context.baseRef}
          options={[...new Set([context.baseRef, ...context.branches])]
            .filter(Boolean)
            .map((value) => ({ value, label: value }))}
          disabled={busy || uncertain}
          onchange={(baseRef) => void load({ baseRef })}
        />{/if}
      {#if context.nextCursor}<Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={async () => {
            const more = await api.createContext(request({ cursor: context?.nextCursor }));
            if (context)
              context = { ...context, branches: [...context.branches, ...more.branches], nextCursor: more.nextCursor };
          }}>Load more branches</Button
        >{/if}
      {#if context.detail}<p role="status" class="text-sm text-amber-700 dark:text-amber-400">{context.detail}</p>{/if}
    {/if}
    <Button size="sm" variant="ghost" disabled={busy || uncertain || !online} onclick={() => void load()}
      >Refresh branch</Button
    >
    <div class="flex flex-wrap gap-2">
      <Button size="sm" disabled={blocked} onclick={() => void agentDraft()}>Draft with agent</Button><Button
        size="sm"
        variant="ghost"
        onclick={() => (preview = !preview)}>{preview ? "Write" : "Preview"}</Button
      >
    </div>
    <Input
      name="pr-title"
      aria-label="Pull request title"
      placeholder="Pull request title"
      bind:value={title}
      disabled={busy || uncertain}
    />
    {#if preview}<Markdown text={body || "Nothing to preview"} />{:else}<Textarea
        name="pr-body"
        aria-label="Pull request description"
        placeholder="Describe the changes in Markdown…"
        rows={7}
        bind:value={body}
        disabled={busy || uncertain}
      />{/if}
    <details>
      <summary class="cursor-pointer text-sm text-zinc-500">Use an agent draft</summary>
      <div class="mt-2 grid gap-2">
        <Textarea
          name="agent-draft"
          aria-label="Agent draft JSON"
          rows={3}
          bind:value={imported}
          disabled={busy || uncertain}
        /><Button size="sm" disabled={!imported || busy || uncertain} onclick={useDraft}>Use draft</Button>
        <p class="text-sm text-zinc-500">Only the title and description are imported. Review them before creating.</p>
      </div>
    </details>
    <Checkbox name="pr-draft" label="Create as draft" bind:checked={draft} disabled={busy || uncertain} />
    {#if context && context.headRepositoryName !== context.repositoryName}<Checkbox
        name="maintainer-modify"
        label="Allow maintainers to modify this branch"
        bind:checked={consent}
        disabled={busy || uncertain}
      />{/if}
    {#if prepared}<p role="status" class="text-sm break-words text-zinc-500">
        Create as {context?.viewerLogin} · {context?.repositoryName} · {context?.baseRef} ← {context?.headRef} · {prepared.headSha.slice(
          0,
          7,
        )}. Confirm within 60 seconds.
      </p>{/if}
    {#if error || receipt?.detail}<p role="alert" class="text-sm text-amber-700 dark:text-amber-400">
        {error || receipt?.detail}
      </p>{/if}
    {#if uncertain}<Button size="sm" disabled={busy || !online} onclick={() => void reconcile()}
        >Check created pull request</Button
      >{/if}
    {#if receipt?.existingPullRequest}<Button size="sm" disabled={busy || !online} onclick={() => void linkExisting()}
        >Link existing pull request #{receipt.existingPullRequest.number}</Button
      >{/if}
  </div>
  <DialogActions
    ><Button onclick={() => (open = false)} disabled={busy}>Cancel</Button><Button
      variant="primary"
      loading={busy}
      disabled={blocked || !title.trim()}
      onclick={() => void submit()}>{prepared ? "Create pull request" : "Review pull request"}</Button
    ></DialogActions
  >
</Dialog>

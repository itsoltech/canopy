<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
  import type { ClassValue } from "svelte/elements";
  import { lifecycleLabel, lifecycleEffect, lifecycleFields, mergeMethodLabel } from "@canopy/domain/github-lifecycle";
  import { mutationRequest, sendMutation, mutationUnconfirmed } from "@canopy/domain/github-mutations";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { methodSegmentLabel } from "@canopy/domain/github-lifecycle-display";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import MergeBlockers from "./MergeBlockers.svelte";
  import ConfirmationCountdown from "./ConfirmationCountdown.svelte";
  import { mutations } from "./api.ts";
  import { mutationRefused, mutationDetail } from "./mutation-errors.ts";
  import { commentDrafts } from "./comment-drafts.ts";

  let {
    snapshot,
    onrefresh,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; onrefresh: () => void; class?: ClassValue } = $props();

  const key = untrack(() => commentDrafts.key(snapshot, "", "lifecycle"));
  let receipt = $state(untrack(() => commentDrafts.read(key, "").receipt));

  let action = $state(""),
    method = $state(""),
    title = $state(""),
    body = $state(""),
    open = $state(false),
    busy = $state(false),
    online = $state(true),
    error = $state("");

  let prepared = $state<github.PullRequestMutationRequest>();
  let expiresAt = $state<Timestamp>();
  const life = $derived(snapshot.lifecycle);
  const actions = $derived(life?.actions ?? []);

  const blocked = $derived(
    busy || !online || snapshot.stale || !!(receipt && (mutationUnconfirmed(receipt) || receipt.state === "accepted")),
  );

  const primary = $derived(
    actions.includes("ready") ? "ready" : life?.inQueue ? "dequeue" : life?.queueRequired ? "enqueue" : "merge",
  );

  const methods = $derived(action === "update_branch" ? (life?.updateMethods ?? []) : (life?.mergeMethods ?? []));

  $effect(() => commentDrafts.save(key, "", receipt));

  $effect(() => {
    if (prepared && (prepared.method !== method || prepared.title !== title || prepared.body !== body))
      prepared = undefined;
  });

  $effect(() => {
    const changed = () => (online = navigator.onLine);
    changed();
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);

    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  });

  function choose(value: string) {
    action = value;
    method = (value === "update_branch" ? life?.updateMethods : life?.mergeMethods)?.[0] ?? "";
    title = life?.mergeTitle ?? snapshot.summary?.title ?? "";
    body = life?.mergeBody ?? "";
    prepared = undefined;
    error = "";
    open = true;
  }

  async function confirm() {
    if (blocked) return;
    busy = true;
    error = "";

    try {
      if (!prepared || !expiresAt || timestampDate(expiresAt).getTime() <= Date.now()) {
        const fields = lifecycleFields(action);
        const r = mutationRequest(snapshot, crypto.randomUUID(), fields.action, { ...fields, method, title, body });
        const p = await mutations.preparePullRequestMutation(r);
        prepared = { ...r, confirmationId: p.confirmationId };
        expiresAt = p.expiresAt;
      } else {
        receipt = await sendMutation(mutations, prepared, mutationRefused, mutationDetail);
        open = false;
        prepared = undefined;
        onrefresh();
      }
    } catch (cause) {
      error = mutationDetail(cause) || "Could not prepare this change. Refresh and check repository access.";
      prepared = undefined;
    } finally {
      busy = false;
    }
  }
</script>

{#if life}
  <div class={["grid min-w-0 gap-2", className]}>
    <div class="flex flex-wrap items-center gap-2">
      {#if ["open", "draft"].includes(snapshot.summary?.state ?? "")}
        <span {@attach tooltip(life.blockingReasons.join(" "))}
          ><Button
            size="sm"
            variant={blocked || !actions.includes(primary) ? "secondary" : "primary"}
            disabled={blocked || !actions.includes(primary)}
            onclick={() => choose(primary)}>{lifecycleLabel(primary)}</Button
          ></span
        >
        {#if primary === "merge" && life.mergeMethods.length > 1}<DropdownMenu label="Merge methods" sheet>
            {#snippet trigger(props)}<IconButton
                icon="chevron-down"
                size="sm"
                label="Merge methods"
                disabled={blocked}
                {...props}
              />{/snippet}
            {#each life.mergeMethods as value}<MenuItem
                onselect={() => {
                  choose("merge");
                  method = value;
                }}>{mergeMethodLabel(value)}</MenuItem
              >{/each}
          </DropdownMenu>{/if}
        {#if actions.includes("update_branch")}<Button
            size="sm"
            disabled={blocked}
            onclick={() => choose("update_branch")}>Update branch</Button
          >{/if}
      {/if}
      {#if actions.some( (a) => ["draft", "close", "reopen", "enable_auto_merge", "disable_auto_merge"].includes(a) )}<DropdownMenu
          label="Lifecycle actions"
          placement="bottom-end"
          sheet
        >
          {#snippet trigger(props)}<IconButton
              icon="ellipsis-horizontal"
              label="Lifecycle actions"
              size="sm"
              disabled={blocked}
              {...props}
            />{/snippet}
          {#each actions.filter( (a) => ["draft", "close", "reopen", "enable_auto_merge", "disable_auto_merge"].includes(a) ) as value}<MenuItem
              onselect={() => choose(value)}>{lifecycleLabel(value)}</MenuItem
            >{/each}
        </DropdownMenu>{/if}
    </div>
    {#if life.autoMergeMethod}<button
        type="button"
        class="w-fit"
        {@attach tooltip(`${mergeMethodLabel(life.autoMergeMethod)} · ${life.autoMergeAuthor}`, { touch: "tap" })}
      >
        <Badge>Auto-merge on</Badge>
      </button>{/if}
    {#if life.inQueue}<p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        Waiting in the merge queue
      </p>{/if}
    <MergeBlockers reasons={life.blockingReasons} />
    {#if life.updateBlockingReason}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        {life.updateBlockingReason}
      </p>{/if}
    {#if !online || snapshot.stale}<p role="status" class="text-sm/5 text-zinc-500">
        Connect and refresh before changing this pull request.
      </p>{/if}
    {#if receipt?.detail}<p role="status" class="text-sm/5 text-amber-700 dark:text-amber-400">{receipt.detail}</p>{/if}
    {#if receipt && (mutationUnconfirmed(receipt) || receipt.state === "accepted")}<Button
        size="sm"
        variant="ghost"
        onclick={() => {
          receipt = undefined;
          onrefresh();
        }}>Check current state</Button
      >{/if}
  </div>
{/if}
<Dialog bind:open title={`${lifecycleLabel(action)}?`} description={lifecycleEffect(action)} dismissible={!busy}>
  <div class="grid min-w-0 gap-3">
    <p class="text-sm break-words text-zinc-500 dark:text-zinc-400">
      {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
    </p>
    <p class="text-sm wrap-anywhere">
      {snapshot.baseRef} ← {snapshot.headRef} ·
      <button
        type="button"
        class="inline-block font-mono select-text"
        {@attach tooltip(prepared?.headSha ?? snapshot.summary?.headSha ?? "", { touch: "tap" })}
        >{(prepared?.headSha ?? snapshot.summary?.headSha)?.slice(0, 7)}</button
      >
    </p>
    {#if ["merge", "enable_auto_merge", "update_branch"].includes(action)}<SegmentedChoice
        label={action === "update_branch" ? "Update method" : "Merge method"}
        options={methods.map((value) => ({ value, label: methodSegmentLabel(value) }))}
        bind:value={method}
        disabled={busy}
      />{/if}
    {#if ["merge", "enable_auto_merge"].includes(action) && method === "SQUASH"}
      <Input
        name="merge-title"
        aria-label="Commit title"
        bind:value={title}
        oninput={() => (prepared = undefined)}
        disabled={busy}
      />
      <Textarea
        name="merge-body"
        aria-label="Commit body"
        rows={1}
        resize={false}
        class="[field-sizing:content] max-h-80 min-h-28"
        bind:value={body}
        oninput={() => (prepared = undefined)}
        disabled={busy}
      />
    {/if}
    {#if prepared}<ConfirmationCountdown {expiresAt} />{/if}
    {#if error}<p role="alert" class="text-sm text-amber-700 dark:text-amber-400">{error}</p>{/if}
  </div>
  <DialogActions
    ><Button variant="ghost" data-autofocus onclick={() => (open = false)} disabled={busy}>Cancel</Button><Button
      variant="primary"
      loading={busy}
      disabled={blocked}
      onclick={() => void confirm()}>{prepared ? lifecycleLabel(action) : "Check requirements"}</Button
    ></DialogActions
  >
</Dialog>

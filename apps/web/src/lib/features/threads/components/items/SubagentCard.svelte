<script lang="ts">
  import { PermissionMode, Provider } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MarkdownSnippet from "#lib/shared/ui/markdown/MarkdownSnippet.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel } from "../../labels.ts";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import ProviderModel from "../ProviderModel.svelte";

  /**
   * A platform subagent started by spawn_thread (docs/agent-bus.md), as the parent's timeline shows it:
   * the child thread's live status, what it runs on (provider, model, effort, permissions) and the start of its last
   * message (its result), linking to the thread. `spawned` is what the call returned, for a thread the directory
   * does not know (its provider as list_agents names it, e.g. "claude/native").
   */
  let {
    threadId,
    title,
    spawned,
    class: className,
  }: {
    threadId: string;
    title: string;
    spawned: { provider: string; model: string; effort: string; permissionMode: string };
    class?: ClassValue;
  } = $props();

  const directory = useThreadDirectory();
  const thread = $derived(directory.thread(threadId));
  const look = $derived(thread ? statusLook(thread.status) : undefined);
  const model = $derived(thread?.model || spawned.model);
  const effort = $derived(thread?.effort || spawned.effort);
  const permission = $derived(
    thread
      ? permissionLabel(thread.permissionMode)
      : spawned.permissionMode
        ? permissionLabel(PermissionMode[spawned.permissionMode.toUpperCase() as keyof typeof PermissionMode])
        : "",
  );
  const provider = $derived(thread?.provider ?? (spawned.provider.startsWith("claude") ? Provider.CLAUDE : spawned.provider.startsWith("codex") ? Provider.CODEX : spawned.provider.startsWith("grok") ? Provider.GROK : undefined));
  const settings = $derived([effort, permission].filter(Boolean));
  const result = $derived(thread?.lastMessage.trim() ?? "");
  const working = $derived(Boolean(look?.active));
</script>

<a
  href="/threads/{threadId}"
  class={[
    "grid gap-1.5 rounded-lg border border-violet-600/15 bg-white p-3 hover:bg-violet-50/60 focus-ring dark:border-violet-400/15 dark:bg-zinc-950 dark:hover:bg-violet-400/5",
    className,
  ]}
>
  <div class="flex min-w-0 items-center gap-2">
    <Icon name="sparkles" class="shrink-0 fill-violet-500 dark:fill-violet-400" />
    <p class="min-w-0 flex-1 truncate text-base/6 font-medium text-zinc-900 sm:text-sm/6 dark:text-zinc-100">{thread?.title || title}</p>
    {#if look}
      <p class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
        <StatusDot tone={look.tone} active={look.active} />{look.label}
      </p>
    {/if}
    <Icon name="chevron-right" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
  </div>
  <p class="flex min-w-0 items-center gap-1 pl-6 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <span class="sr-only">Subagent runs on: </span>
    {#if provider}<ProviderModel {provider} model={model} class="shrink-0" />{:else}<span class="shrink-0">{model || "Default model"}</span>{/if}
    {#if settings.length > 0}<span class="truncate">· {settings.join(" · ")}</span>{/if}
  </p>
  <p class="line-clamp-3 pl-6 text-base/6 text-pretty text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
    {#if result}
      <span class="sr-only">Last message: </span><MarkdownSnippet text={result} />
    {:else}
      <span class="text-zinc-500 italic dark:text-zinc-400">{working ? "Working on it…" : "No message yet"}</span>
    {/if}
  </p>
</a>

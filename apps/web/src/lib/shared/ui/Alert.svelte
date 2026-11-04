<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";

  type AlertTone = "info" | "warning" | "error";

  /**
   * Inline message. `error` is announced immediately (role=alert), the others politely (role=status).
   * `banner` drops the rounded frame for full-width strips under a header. Only offending fields shake;
   * messages stay still so a service error cannot resemble a field validation failure.
   */
  let {
    tone = "info",
    title,
    banner = false,
    class: className,
    children,
    actions,
  }: {
    tone?: AlertTone;
    title?: string;
    banner?: boolean;
    class?: ClassValue;
    children?: Snippet;
    actions?: Snippet;
  } = $props();

  const looks: Record<AlertTone, { icon: IconName; box: string; icon_: string; title: string; body: string }> = {
    info: {
      icon: "information-circle",
      box: "bg-sky-50 ring-sky-600/15 dark:bg-sky-400/10 dark:ring-sky-400/20",
      icon_: "text-sky-600 dark:text-sky-400",
      title: "text-sky-950 dark:text-sky-100",
      body: "text-sky-900 dark:text-sky-200",
    },
    warning: {
      icon: "exclamation-triangle",
      box: "bg-amber-50 ring-amber-600/20 dark:bg-amber-400/10 dark:ring-amber-400/20",
      icon_: "text-amber-600 dark:text-amber-400",
      title: "text-amber-950 dark:text-amber-100",
      body: "text-amber-900 dark:text-amber-200",
    },
    error: {
      icon: "exclamation-circle",
      box: "bg-rose-50 ring-rose-600/20 dark:bg-rose-400/10 dark:ring-rose-400/20",
      icon_: "text-rose-600 dark:text-rose-400",
      title: "text-rose-950 dark:text-rose-100",
      body: "text-rose-900 dark:text-rose-200",
    },
  };

  const look = $derived(looks[tone]);
</script>

<div
  class={[
    "flex items-start gap-3 text-base/6 sm:text-sm/6",
    look.box,
    banner ? "px-4 py-2.5 sm:px-6" : "rounded-lg p-3 ring-1 ring-inset",
    className,
  ]}
  role={tone === "error" ? "alert" : "status"}
>
  <div class="flex h-lh items-center"><Icon name={look.icon} class={look.icon_} /></div>
  <div class="min-w-0 flex-1">
    {#if title}<p class={["font-medium", look.title]}>{title}</p>{/if}
    {#if children}<div class={["text-pretty break-words", look.body]}>{@render children()}</div>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</div>

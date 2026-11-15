import type { HtmlTag } from "@canopy/domain/markdown";

const heading = "font-semibold text-zinc-950 dark:text-white";
const emphasis = "font-semibold text-zinc-950 dark:text-white";
const code = "rounded-sm bg-zinc-950/5 px-1 py-px font-mono dark:bg-white/10";

const classes: Partial<Record<HtmlTag, string>> = {
  h1: `${heading} text-lg/7 sm:text-base/7`,
  h2: `${heading} text-base/7`,
  h3: `${heading} text-base/6 sm:text-sm/6`,
  h4: `${heading} text-base/6 sm:text-sm/6`,
  h5: `${heading} text-base/6 sm:text-sm/6`,
  h6: `${heading} text-base/6 sm:text-sm/6`,
  strong: emphasis,
  b: emphasis,
  em: "italic",
  i: "italic",
  del: "line-through",
  s: "line-through",
  strike: "line-through",
  u: "underline",
  ins: "underline",
  code,
  kbd: `${code} border border-zinc-950/10 dark:border-white/15`,
  pre: "overflow-x-auto rounded-lg bg-zinc-950/5 p-3 font-mono whitespace-pre dark:bg-white/5",
  blockquote: "border-l-2 border-zinc-950/10 pl-3 text-zinc-600 dark:border-white/15 dark:text-zinc-400",
  ul: "list-disc pl-5 marker:text-zinc-400 dark:marker:text-zinc-500",
  ol: "list-decimal pl-5 marker:text-zinc-400 dark:marker:text-zinc-500",
  li: "pl-1",
  dt: emphasis,
  dd: "pl-3 text-zinc-600 dark:text-zinc-400",
  table: "w-full text-left text-base/7 sm:text-sm/6",
  tr: "border-b border-zinc-950/10 last:border-0 dark:border-white/10",
  th: `${emphasis} px-2 py-1.5 align-top whitespace-nowrap`,
  td: "px-2 py-1.5 align-top",
  details: "rounded-lg border border-zinc-950/10 p-3 dark:border-white/10",
  summary: "cursor-pointer font-medium focus-ring",
};

export const htmlClasses = (tag: HtmlTag) => classes[tag];

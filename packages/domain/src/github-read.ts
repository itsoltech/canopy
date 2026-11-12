import type { github } from "@canopy/contracts";
import type { PullRequestLook } from "./github-pr.ts";

export const activityFilters = [
  { value: "", label: "All activity" },
  { value: "comment", label: "Comments" },
  { value: "review", label: "Reviews" },
  { value: "commit", label: "Commits" },
  { value: "event", label: "Events" },
];

export type Activity =
  | { kind: "event"; key: string; items: github.PullRequestTimelineItem[] }
  | { kind: "thread"; key: string; thread: github.PullRequestReviewThread };

const hiddenTimelineEvents = new Set(["MentionedEvent", "SubscribedEvent", "UnsubscribedEvent"]);

/** Apply to upstream pages and cached items, including union members with only a type name. */
export function visibleTimelineItem(item: github.PullRequestTimelineItem): boolean {
  const entry = item.content.value;

  if (!entry) return false;

  return (
    item.content.case !== "event" || (!hiddenTimelineEvents.has(entry.kind) && !!(entry.createdAt || entry.body.trim()))
  );
}

/** Merge the independently paged review feed, then group adjacent commits by their author. */
export function pullRequestActivity(
  items: readonly github.PullRequestTimelineItem[],
  threads: readonly github.PullRequestReviewThread[],
  oldest: boolean,
): Activity[] {
  const rows = [
    ...items.flatMap((item, index) =>
      visibleTimelineItem(item)
        ? [
            {
              time: item.content.value?.createdAt?.seconds ?? 0n,
              row: { kind: "event", key: item.content.value?.id ?? `event:${index}`, items: [item] } satisfies Activity,
            },
          ]
        : [],
    ),
    ...threads.map((thread) => ({
      time: thread.comments[0]?.createdAt?.seconds ?? 0n,
      row: { kind: "thread", key: `thread:${thread.id}`, thread } satisfies Activity,
    })),
  ].sort((a, b) => (a.time === b.time ? 0 : (a.time < b.time ? -1 : 1) * (oldest ? 1 : -1)));

  const result: Activity[] = [];

  for (const { row } of rows) {
    const last = result.at(-1);

    if (
      row.kind === "event" &&
      last?.kind === "event" &&
      row.items[0]?.content.case === "commit" &&
      last.items[0]?.content.case === "commit" &&
      row.items[0].content.value.author === last.items[0].content.value.author
    )
      last.items.push(...row.items);
    else result.push(row);
  }

  return result;
}

export function fileLook(file: github.PullRequestFile): PullRequestLook {
  if (file.patchState === "binary") return { icon: "photo", label: "Binary file", tone: "muted", rank: 0 };
  const state = file.state.toLowerCase();

  switch (state) {
    case "added":
      return { icon: "plus", label: "Added file", tone: "success", rank: 0 };
    case "removed":
    case "deleted":
      return { icon: "trash", label: "Deleted file", tone: "danger", rank: 0 };
    case "renamed":
      return { icon: "arrows-right-left", label: "Renamed file", tone: "muted", rank: 0 };
    default:
      return { icon: "pencil-square", label: "Modified file", tone: "muted", rank: 0 };
  }
}

export type FileRow =
  | { kind: "folder"; key: string; depth: number; name: string }
  | { kind: "file"; key: string; depth: number; file: github.PullRequestFile };

/** Only loaded pages enter the tree. Folder collapse never fetches patches. */
export function fileRows(
  files: readonly github.PullRequestFile[],
  tree: boolean,
  collapsed: ReadonlySet<string>,
): FileRow[] {
  if (!tree) return files.map((file) => ({ kind: "file", key: file.path, depth: 0, file }));
  const rows: FileRow[] = [];
  const seen = new Set<string>();

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split("/");
    let hidden = false;

    for (let depth = 0; depth < parts.length - 1; depth++) {
      const key = parts.slice(0, depth + 1).join("/");

      if (!seen.has(key)) {
        rows.push({ kind: "folder", key, depth, name: parts[depth]! });
        seen.add(key);
      }

      if (collapsed.has(key)) {
        hidden = true;
        break;
      }
    }

    if (!hidden) rows.push({ kind: "file", key: file.path, depth: parts.length - 1, file });
  }

  return rows;
}

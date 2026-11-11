import { useState } from "react";
import type { github } from "@canopy/contracts";

export function useViewedCount(page: github.PullRequestFilesPage | undefined) {
  const [changes, setChanges] = useState(new Map<string, string>());
  const [source, setSource] = useState(page);

  if (source !== page) {
    setSource(page);
    setChanges(new Map());
  }

  const count =
    (page?.viewedCount ?? 0) +
    (page?.files ?? []).reduce(
      (n, f) =>
        n +
        (changes.has(f.path) ? Number(changes.get(f.path) === "VIEWED") - Number(f.viewerViewedState === "VIEWED") : 0),
      0,
    );

  return {
    label: page?.viewedComplete ? `${count}/${page.viewedTotal}` : "…",
    change: (path: string, state: string) => setChanges((previous) => new Map(previous).set(path, state)),
  };
}

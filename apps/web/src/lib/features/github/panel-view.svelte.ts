import { queries } from "#lib/shared/queries.svelte.ts";

class PanelView {
  tab = $state("summary");
  visited = $state(["summary"]);
  scroll: Record<string, number> = {};
  revision = "";

  select(value: string) {
    if (!this.visited.includes(value)) this.visited = [...this.visited, value];
    this.tab = value;
  }
}

/** The session LRU retains presentation state without storing private data on disk. */
export function panelView(id: string) {
  const key = `PullRequestView:${id}`;
  const saved = queries.snapshot<PanelView>(key).data;

  if (saved) return saved;
  const view = new PanelView();
  queries.set(key, view);

  return view;
}

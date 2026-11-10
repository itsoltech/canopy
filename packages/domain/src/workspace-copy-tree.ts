import type { WorkspaceCopyEntry } from "@canopy/contracts";

export interface CopyTreeNode {
  key: string;
  path: string;
  label: string;
  depth: number;
  children: CopyTreeNode[];
  members: string[];
  bytes: bigint;
  files: number;
  secret: boolean;
  blocked: string;
  ignored: boolean;
}

/** Build once per preview. Collapsed directories never mount their descendants in either client. */
export function copyTree(entries: readonly WorkspaceCopyEntry[]) {
  const nodes = new Map<string, CopyTreeNode>();
  const roots: CopyTreeNode[] = [];
  const groupLabels = { files: "Repository files", ignored: "Ignored files", git: "Git metadata" };

  for (const entry of entries) {
    const group = entry.metadata ? "git" : entry.ignored ? "ignored" : "files";
    const parts = entry.path.split("/");

    if (entry.metadata) parts.shift();
    const chain = ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
    let parent: CopyTreeNode | undefined;

    for (const [depth, path] of chain.entries()) {
      const key = `${group}:${path}`;
      let node = nodes.get(key);

      if (!node) {
        node = {
          key,
          path,
          label: depth ? parts[depth - 1]! : groupLabels[group],
          depth,
          children: [],
          members: [],
          bytes: 0n,
          files: 0,
          secret: false,
          blocked: "",
          ignored: group === "ignored",
        };
        nodes.set(key, node);

        if (parent) parent.children.push(node);
        else roots.push(node);
      }

      if (!entry.blocked) node.members.push(entry.path);
      node.bytes += entry.size;

      if (!entry.directory) node.files++;
      node.secret ||= entry.secret;

      if (depth === chain.length - 1) node.blocked = entry.blocked;
      parent = node;
    }
  }

  for (const node of nodes.values())
    node.children.sort(
      (a, b) =>
        Number(Boolean(b.children.length)) - Number(Boolean(a.children.length)) || a.label.localeCompare(b.label),
    );

  return roots.sort(
    (a, b) =>
      Object.keys(groupLabels).indexOf(a.key.split(":")[0]!) - Object.keys(groupLabels).indexOf(b.key.split(":")[0]!),
  );
}

export function visibleCopyTree(
  roots: readonly CopyTreeNode[],
  expanded: ReadonlySet<string>,
  query = "",
): CopyTreeNode[] {
  const result: CopyTreeNode[] = [];
  const needle = query.trim().toLowerCase();

  const visit = (node: CopyTreeNode) => {
    if (!needle || `${node.path} ${node.label}`.toLowerCase().includes(needle)) result.push(node);

    if (needle || expanded.has(node.key)) node.children.forEach(visit);
  };

  roots.forEach(visit);

  return result;
}

export function toggleCopyNode(selected: ReadonlySet<string>, node: CopyTreeNode): Set<string> {
  const next = new Set(selected);
  const remove = node.members.every((p) => selected.has(p));

  for (const path of node.members) {
    if (remove) next.delete(path);
    else next.add(path);
  }

  return next;
}

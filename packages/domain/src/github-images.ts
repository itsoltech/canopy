import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export interface GitHubImage {
  src: string;
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
}

export type GitHubHtmlPart = { kind: "text"; text: string } | { kind: "br" } | { kind: "image"; image: GitHubImage };

const dimension = (value: string | undefined) => {
  if (!value || !/^\d+(?:px)?$/.test(value)) return undefined;
  const size = Number.parseInt(value, 10);

  return size > 0 && size <= 4096 ? size : undefined;
};

/** Parse inert data only. No source tag, style, event handler or executable URL reaches a renderer. */
export function githubHtmlParts(html: string): GitHubHtmlPart[] {
  const parts: GitHubHtmlPart[] = [];

  const visit = (node: DefaultTreeAdapterMap["childNode"]) => {
    if (node.nodeName === "#text" && "value" in node) parts.push({ kind: "text", text: node.value });

    if (!("tagName" in node)) return;

    if (node.tagName === "br") parts.push({ kind: "br" });
    else if (node.tagName === "img") {
      const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
      parts.push({
        kind: "image",
        image: {
          src: attr("src") ?? "",
          alt: attr("alt") ?? "",
          width: dimension(attr("width")),
          height: dimension(attr("height")),
        },
      });
    } else for (const child of node.childNodes) visit(child);
  };

  for (const node of parseFragment(html).childNodes) visit(node);

  return parts;
}

/** Exact HTTPS hosts only; github.com is restricted to attachment assets. */
export function githubImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;

    if (url.hostname === "github.com") {
      if (!/^\/user-attachments\/assets\/[a-zA-Z0-9-]+$/.test(url.pathname)) return;
    } else if (
      ![
        "private-user-images.githubusercontent.com",
        "user-images.githubusercontent.com",
        "raw.githubusercontent.com",
        "camo.githubusercontent.com",
      ].includes(url.hostname)
    )
      return;

    return url.href;
  } catch {
    return undefined;
  }
}

/** GitHub can wrap an image in an original-URL link or retain it in data-canonical-src. */
export function resolvedGitHubImage(html: string, source: string): string | undefined {
  let resolved: string | undefined;

  const visit = (node: DefaultTreeAdapterMap["childNode"], link = "") => {
    if (!("tagName" in node)) return;
    const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value ?? "";

    if (node.tagName === "img" && [attr("src"), attr("data-canonical-src"), link].includes(source))
      resolved = githubImageUrl(attr("src"));

    for (const child of node.childNodes) visit(child, node.tagName === "a" ? attr("href") : link);
  };

  for (const node of parseFragment(html).childNodes) visit(node);

  return resolved;
}

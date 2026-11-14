import { createHash } from "node:crypto";
import type { Session } from "electron";
import { KIT_SCRIPT_CSP } from "@canopy/domain/visual-compiler";

export class DocumentPolicy {
  private readonly scriptHashes = new Map<string, Set<string>>();

  async prepare(url: string) {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });

    if (!response.ok) throw new Error("The Canopy web address did not return an application page");
    const html = await response.text();
    const origin = new URL(url).origin;
    const hashes = this.scriptHashes.get(origin) ?? new Set<string>();

    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
      hashes.add(
        `'sha256-${createHash("sha256")
          .update(match[1] ?? "")
          .digest("base64")}'`,
      );
    this.scriptHashes.set(origin, hashes);
  }

  attach(session: Session, origins: () => (string | undefined)[]) {
    // Only documents need these hooks. Unfiltered, every script, fetch and font would wait for a
    // round trip through this process (busy with menus and IPC) before reaching the network.
    const documents: Electron.WebRequestFilter = { urls: ["<all_urls>"], types: ["mainFrame"] };
    // Refresh hashes for every document (including reloading a nested SvelteKit route).
    session.webRequest.onBeforeRequest(documents, (details, callback) => {
      if (details.resourceType === "mainFrame" && origins().includes(new URL(details.url).origin)) {
        void this.prepare(details.url)
          .then(() => callback({}))
          .catch(() => callback({ cancel: true }));
      } else callback({});
    });
    // Restrict executable code to the selected origin. Svelte needs inline style attributes; no eval. Sandboxed
    // visual frames (srcdoc) inherit this policy, so it also admits exactly the pinned visual kit script.
    session.webRequest.onHeadersReceived(documents, (details, callback) => {
      let headers = details.responseHeaders;

      if (details.resourceType === "mainFrame" && origins().includes(new URL(details.url).origin)) {
        const hashes = [...(this.scriptHashes.get(new URL(details.url).origin) ?? [])].join(" ");
        // KIT_SCRIPT_CSP also admits that one script in the main window itself: srcdoc frames inherit this
        // policy, so the hash can't be scoped to them. It matches only the pinned visual kit, nothing else inline.
        headers = {
          ...headers,
          "Content-Security-Policy": [
            `default-src 'self'; script-src 'self' ${hashes} ${KIT_SCRIPT_CSP}; style-src 'self' 'unsafe-inline' https://rsms.me; font-src 'self' https://rsms.me data:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'`,
          ],
        };
      }

      callback(headers ? { responseHeaders: headers } : {});
    });
  }
}

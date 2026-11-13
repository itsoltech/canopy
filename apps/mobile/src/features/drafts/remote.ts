import type { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";

/** A bounded page shared by all mounted composer hints and sheets. */
export class MobileRemoteDrafts {
  #page: ui.ComposerDraftPage | undefined;
  #pending: Promise<ui.ComposerDraftPage> | undefined;
  invalidate() {
    this.#page = undefined;
  }
  async load(api: Client<typeof ui.GatewayService>, deviceId: string, more = false): Promise<ui.ComposerDraftPage> {
    if (this.#pending) {
      const page = await this.#pending;

      if (!more) return page;
    }

    if (!more && this.#page) return this.#page;
    const previous = this.#page;
    this.#pending = api
      .listComposerDrafts({ deviceId, pageSize: 20, pageToken: more ? (previous?.nextPageToken ?? "") : "" })
      .then((page) => {
        this.#page =
          more && previous
            ? {
                ...page,
                drafts: [...new Map([...previous.drafts, ...page.drafts].map((row) => [row.id, row])).values()].slice(
                  0,
                  100,
                ),
              }
            : page;

        return this.#page;
      });

    try {
      return await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }
}

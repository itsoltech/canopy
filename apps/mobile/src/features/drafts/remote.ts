import type { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";
import { loadComposerDraftPages } from "@canopy/domain/composer-drafts";

/** A bounded list shared by composer tabs and sidebar markers. */
export class MobileRemoteDrafts {
  #page: ui.ComposerDraftPage | undefined;
  #pending: Promise<ui.ComposerDraftPage> | undefined;
  #generation = 0;
  invalidate() {
    this.#generation++;
    this.#page = undefined;
  }
  async load(
    api: Client<typeof ui.GatewayService>,
    deviceId: string,
    more = false,
    sourceDraftIds: string[] = [],
  ): Promise<ui.ComposerDraftPage> {
    if (this.#pending) {
      const page = await this.#pending;

      if (!more && this.#page) return page;

      return this.load(api, deviceId, more, sourceDraftIds);
    }

    if (!more && this.#page) return this.#page;
    const previous = this.#page;
    const generation = this.#generation;
    this.#pending = loadComposerDraftPages(
      (token) =>
        api.listComposerDrafts({
          deviceId,
          pageSize: 20,
          pageToken: token,
          sourceDraftIds: sourceDraftIds.slice(0, 100),
        }),
      more ? (previous?.nextPageToken ?? "") : "",
    ).then((page) => {
      if (generation !== this.#generation) return page;
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

    let page: ui.ComposerDraftPage;

    try {
      page = await this.#pending;
    } finally {
      this.#pending = undefined;
    }

    return generation === this.#generation ? page : this.load(api, deviceId, false, sourceDraftIds);
  }
}

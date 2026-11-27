import type { ui } from "@canopy/contracts";
import { messengerAccounts } from "#lib/features/bots/messengers/api.ts";

/** Messenger accounts for the Messaging settings tab: one request shared by every provider section. */
export class MessengerCatalog {
  response = $state<ui.ListMessengerAccountsResponse>();
  loading = $state(true);
  failed = $state(false);
  ready = $state(false);
  #fetchId = 0;

  get accounts(): ui.MessengerAccount[] {
    return this.response?.accounts ?? [];
  }

  async reload() {
    const id = ++this.#fetchId;

    try {
      const next = await messengerAccounts();

      if (id !== this.#fetchId) return;
      this.response = next;
      this.ready = true;
      this.failed = false;
    } catch {
      if (id === this.#fetchId) this.failed = true;
    } finally {
      if (id === this.#fetchId) this.loading = false;
    }
  }

  /** Reloads on focus, on changes from other components and every 30 seconds. Returns the cleanup. */
  watch() {
    void this.reload();

    const refresh = () => {
      if (!document.hidden) void this.reload();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("messenger-accounts-changed", refresh);
    const timer = setInterval(refresh, 30_000);

    return () => {
      ++this.#fetchId;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("messenger-accounts-changed", refresh);
    };
  }

  saved(account: ui.MessengerAccount) {
    if (this.response)
      this.response.accounts = this.accounts.some((entry) => entry.id === account.id)
        ? this.accounts.map((entry) => (entry.id === account.id ? account : entry))
        : [...this.accounts, account];
    changed();
  }

  removed(id: string) {
    if (this.response) this.response.accounts = this.accounts.filter((account) => account.id !== id);
    changed();
  }
}

export function changed() {
  window.dispatchEvent(new Event("messenger-accounts-changed"));
}

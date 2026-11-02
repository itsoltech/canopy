import { bots } from "@open-agents/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/**
 * Your bots with their last messages, shared by the sidebar and the chats (names, avatars, mentions):
 * one request every 5 s while anything uses it, and at once after a "bots-changed" event.
 */
class BotList {
  list = $state.raw<bots.Bot[]>([]);
  loaded = $state(false);
  error = $state("");
  #users = 0;
  #stop: (() => void) | undefined;

  /** Keeps the list fresh until the returned function is called (use it from an `$effect`). */
  use(): () => void {
    if (this.#users++ === 0) {
      const refresh = () => void this.refresh();
      const timer = setInterval(refresh, 5000);
      window.addEventListener("bots-changed", refresh);
      this.#stop = () => {
        clearInterval(timer);
        window.removeEventListener("bots-changed", refresh);
      };
      refresh();
    }
    return () => {
      if (--this.#users === 0) this.#stop?.();
    };
  }

  async refresh(): Promise<void> {
    try {
      this.list = decode(bots.ListBotsResponseSchema, await requestJson("GET", "/api/bots")).bots;
      this.error = "";
    } catch {
      this.error = "Could not load bots";
    } finally {
      this.loaded = true;
    }
  }
}

export const botList = new BotList();

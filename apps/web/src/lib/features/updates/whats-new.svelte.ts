import { AppUpdateHistory } from "@canopy/domain/release/app-history";
import { deviceViewStorageKey } from "@canopy/domain/device-view";
import { aggregateNotes } from "@canopy/domain/release/note-range";
import { parseNotesIndex, recentNotes, type NotesIndex } from "@canopy/domain/release/notes";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { requestJson } from "#lib/shared/http.ts";
import type { DesktopAppHistory } from "@canopy/ui/desktop";

export class WhatsNewState {
  current = $state(CANOPY_VERSION);
  previous = $state("");
  notice = $state(false);
  open = $state(false);
  recent = $state(false);
  index = $state<NotesIndex>();
  pending = $state(false);
  error = $state("");
  #generation = 0;

  get range() {
    return this.index && this.previous ? aggregateNotes(this.index, this.previous, this.current) : undefined;
  }

  get releases() {
    return this.index ? recentNotes(this.index, this.current) : [];
  }

  connectWeb(scope: string) {
    const key = deviceViewStorageKey(`updates.web.${scope}`);

    const history = new AppUpdateHistory((raw) => {
      try {
        localStorage.setItem(key, raw);
      } catch {
        // Storage-denied browsers keep a baseline in memory and do not replay the full history.
      }
    });

    try {
      history.load(localStorage.getItem(key));
    } catch {
      history.load(null);
    }

    const updated = history.observe(CANOPY_VERSION);
    this.receive({ version: CANOPY_VERSION, from: history.range?.from ?? "", updated });
  }

  receive(history: DesktopAppHistory) {
    this.#generation++;
    this.pending = false;
    this.error = "";
    this.open = false;
    this.current = history.version;
    this.previous = history.from;
    this.notice = history.updated;
    this.recent = !history.from;

    if (history.updated) void this.load();
  }

  show() {
    this.notice = false;
    this.open = true;
    this.recent = !this.previous;

    if (!this.index && !this.pending) void this.load();
  }

  async load() {
    const generation = this.#generation;
    this.pending = true;
    this.error = "";

    try {
      const bridge = window.canopyDesktop;

      const text = bridge?.releaseNotes
        ? await bridge.releaseNotes()
        : JSON.stringify(await requestJson("GET", "/api/updates/whats-new", undefined, 25_000));

      const index = parseNotesIndex(text);

      if (generation === this.#generation) this.index = index;
    } catch {
      if (generation === this.#generation)
        this.error = "Could not load release notes. Retry or view releases on GitHub.";
    } finally {
      if (generation === this.#generation) this.pending = false;
    }
  }
}

export const whatsNew = new WhatsNewState();

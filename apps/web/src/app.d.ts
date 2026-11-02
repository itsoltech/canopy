// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ui } from "@open-agents/contracts";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Settings requested by `handle` for a page request (null: gateway down). */
      settings?: Promise<ui.GetSettingsResponse | null>;
    }
    // interface PageData {}
    interface PageState {
      /** Settings open as an overlay (shallow routing): the page underneath, to go back to after a reload. */
      settingsOver?: string;
    }
    // interface Platform {}
  }
}

export {};

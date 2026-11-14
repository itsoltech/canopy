// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
  namespace App {
    interface Error {
      message: string;
      /** `assets`: part of the app did not download (a dropped connection, a removed release). */
      scope?: "computer" | "assets";
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

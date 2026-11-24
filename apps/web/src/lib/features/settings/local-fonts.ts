import { fontFamilies, quoteFontFamily, validFontFamily } from "@canopy/ui/fonts";

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<{ family: string }[]>;
  }
}

export type FontDiscovery =
  | { state: "idle" | "loading" | "prompt" | "unavailable" | "failed" }
  | { state: "ready"; families: string[] };

/** Check if enumeration can run without prompting for browser permission. */
export async function installedFontAccess(): Promise<"granted" | "prompt" | "unavailable"> {
  if (window.canopyDesktop?.listFonts) return "granted";

  if (!window.queryLocalFonts) return "unavailable";

  try {
    // SAFETY: Chromium supports local-fonts, which is missing from TypeScript's DOM types.
    const { state } = await navigator.permissions.query({ name: "local-fonts" as PermissionName });

    return state === "denied" ? "unavailable" : state;
  } catch {
    return "prompt";
  }
}

export async function installedFonts(): Promise<string[]> {
  try {
    if (window.queryLocalFonts) {
      const families = fontFamilies((await window.queryLocalFonts()).map((font) => font.family));

      if (families.length) return families;
    }
  } catch {
    // Electron can enumerate in main if Chromium's API is unavailable or denied.
  }

  if (window.canopyDesktop?.listFonts) return fontFamilies(await window.canopyDesktop.listFonts());

  throw new Error("Could not enumerate local font families");
}

let context: CanvasRenderingContext2D | null | undefined;

function fontContext() {
  context ??= document.createElement("canvas").getContext("2d");

  return context;
}

export function fontInstalled(family: string): boolean {
  if (!validFontFamily(family)) return false;
  const quoted = quoteFontFamily(family);
  const canvas = fontContext();

  if (!canvas || !document.fonts.check(`16px ${quoted}`)) return false;

  // FontFaceSet.check alone returns true for missing families. Compare several generic fallbacks;
  // a family identical to one fallback still differs from the other two.
  return ["monospace", "sans-serif", "serif"].some((fallback) => {
    const sample = "mmmmmmWWWWWWiiiiii0123456789";
    canvas.font = `72px ${fallback}`;
    const baseline = canvas.measureText(sample).width;
    canvas.font = `72px ${quoted}, ${fallback}`;

    return Math.abs(canvas.measureText(sample).width - baseline) > 0.1;
  });
}

export function fontMonospace(family: string): boolean {
  const canvas = fontContext();

  if (!canvas) return false;
  canvas.font = `32px ${quoteFontFamily(family)}, monospace`;

  return Math.abs(canvas.measureText("iiiiii").width - canvas.measureText("WWWWWW").width) < 0.1;
}

const previews = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

/** Only visible rows resolve a local font face; offscreen families never trigger font shaping. */
export function lazyFontPreview(node: HTMLElement, show: () => void): () => void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previews.get(entry.target)?.();
      observer?.unobserve(entry.target);
    }
  });
  previews.set(node, show);
  observer.observe(node);

  return () => {
    observer?.unobserve(node);
    previews.delete(node);
  };
}

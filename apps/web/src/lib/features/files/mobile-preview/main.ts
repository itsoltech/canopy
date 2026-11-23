import { mount } from "svelte";
import { num, objectOf, parseObject, str } from "@canopy/domain/json";
import { safeHref } from "@canopy/domain/markdown";
import { isThemeName, paletteStyle, themeVariables } from "@canopy/ui/themes";
import { deviceChoices, devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { applyDeviceAppearance } from "#lib/features/settings/device-appearance.ts";
import Preview from "./Preview.svelte";
import { connectPreview, request } from "./bridge.ts";
import "./preview.css";

const data = parseObject(document.getElementById("preview-data")?.textContent ?? "");
const values = objectOf(data["preferences"]);
const root = document.documentElement;
const mode = data["dark"] === true ? "dark" : "light";
const theme = str(data["theme"]);
const name = isThemeName(theme) ? theme : "birch";

root.classList.toggle("dark", mode === "dark");

root.dataset["darkTheme"] = name;

root.dataset["lightTheme"] = name;

root.style.cssText = paletteStyle(name, name);

root.style.colorScheme = mode;

if (!CSS.supports("color", "light-dark(white, black)"))
  for (const [key, value] of Object.entries(themeVariables(name, mode)))
    root.style.setProperty(`--theme-${key}`, value);

for (const key of [
  "interfaceFont",
  "interfaceSize",
  "monoFont",
  "monoSize",
  "contrast",
  "wrapCode",
  "wrapDiffs",
  "diffLayout",
  "diffColors",
] as const) {
  const input = str(values[key]);

  if (deviceChoices[key].some((choice) => choice === input)) devicePreferences.values[key] = input;
}

applyDeviceAppearance(devicePreferences);

const fontScale = num(data["fontScale"]);

if (fontScale > 0) root.style.fontSize = `${(16 * Number(devicePreferences.values.interfaceSize) * fontScale) / 14}px`;

connectPreview();

mount(Preview, { target: document.body, props: { text: str(data["text"]), path: str(data["path"]) } });

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;

  if (!link || event.defaultPrevented) return;
  event.preventDefault();
  const target = link.getAttribute("href") ?? "";

  if (target.startsWith("#")) {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find(
      (node) =>
        "#" +
          (node.textContent ?? "")
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .replace(/\s+/g, "-") ===
        target,
    );

    heading?.scrollIntoView();
  } else {
    const href = safeHref(target);

    if (href && event.isTrusted) void request("external", href).catch(() => undefined);
  }
});

window.ReactNativeWebView?.postMessage('{"action":"ready"}');

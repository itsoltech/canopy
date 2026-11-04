import colors from "tailwindcss/colors";

// RN's native colour parser cannot read Tailwind's OKLCH values. Generate clipped
// sRGB from the exact web dependency, rather than maintaining another palette.
function srgb(value: string): string {
  const match = /oklch\(([\d.]+)% ([\d.]+) ([\d.]+|none)\)/.exec(value);

  if (!match) throw new Error(`Unsupported Tailwind colour: ${value}`);

  const L = Number(match[1]) / 100,
    C = Number(match[2]),
    h = (Number(match[3] === "none" ? 0 : match[3]) * Math.PI) / 180;

  const a = C * Math.cos(h),
    b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return (
    "#" +
    channels
      .map((v) =>
        Math.round(Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

const names = [
  "zinc",
  "blue",
  "emerald",
  "sky",
  "orange",
  "violet",
  "pink",
  "amber",
  "rose",
  "lime",
  "teal",
  "fuchsia",
  "cyan",
] as const;

const webPackage = await Bun.file(new URL("../../../apps/web/package.json", import.meta.url)).json();
const ownPackage = await Bun.file(new URL("../package.json", import.meta.url)).json();

if (webPackage.devDependencies.tailwindcss !== ownPackage.devDependencies.tailwindcss)
  throw new Error("Use the same Tailwind version in web and ui before generating the native palette.");

const palette = Object.fromEntries(
  names.map((name) => [
    name,
    Object.fromEntries(Object.entries(colors[name]).map(([shade, value]) => [shade, srgb(value)])),
  ]),
);

const output = JSON.stringify(palette, null, 2) + "\n";
const file = Bun.file(new URL("../src/palette.json", import.meta.url));

if (Bun.argv.includes("--check")) {
  if ((await file.text()) !== output)
    throw new Error("Native palette differs from web Tailwind. Run bun --cwd packages/ui gen.");
} else await Bun.write(file, output);

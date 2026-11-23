import { canopyTree } from "./canopy-tree.ts";
import { palette } from "./tokens.ts";

const tree = `<path fill-rule="evenodd" d="${canopyTree.outline}"/>`;

// White stops in a luminance mask fade the entire scene together on web and react-native-svg.
function scene(channel: string, drawing: string, surroundings = "") {
  const id = `canopy-sidebar-${channel}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 20 200 125" preserveAspectRatio="xMaxYMin meet" fill="currentColor">
    <defs>
      <linearGradient id="${id}-fade" gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="0" y2="139">
        <stop offset="0" stop-color="white"/>
        <stop offset=".28" stop-color="white" stop-opacity=".96"/>
        <stop offset=".55" stop-color="white" stop-opacity=".76"/>
        <stop offset=".76" stop-color="white" stop-opacity=".4"/>
        <stop offset=".91" stop-color="white" stop-opacity=".1"/>
        <stop offset="1" stop-color="white" stop-opacity="0"/>
      </linearGradient>
      <mask id="${id}-mask" maskUnits="userSpaceOnUse" x="0" y="20" width="200" height="125">
        <rect y="20" width="200" height="125" fill="url(#${id}-fade)"/>
      </mask>
    </defs>
    <g mask="url(#${id}-mask)">
      ${surroundings}
      <g transform="translate(32 18) scale(1.18)">${drawing}</g>
    </g>
  </svg>`;
}

const guides = `<g fill="none" stroke="currentColor">
  <path opacity=".065" stroke-width=".55" d="
    M59 22h145 M43 42h161 M33 62h171 M37 102h167 M47 122h157 M67 142h137 M89 162h115
    M55 34v89 M75 20v120 M95 10v145 M115 5v162 M155 4v160 M175 9v151 M195 14v136"/>
  <path opacity=".11" stroke-width=".65" stroke-dasharray="3 3" d="M135 7v181 M24 82h180"/>
  <path opacity=".14" stroke-width=".75" d="M27 18v168 M23 18h20 M23 186h20 M24 21l6-6m-6 174 6-6"/>
</g>`;

const stars = `<g>
  <path opacity=".18" d="
    M79 27q.8 4.8 5 5.5-4.2.7-5 5.5-.8-4.8-5-5.5 4.2-.7 5-5.5z
    M179 25q.6 3 3.5 3.6-2.9.6-3.5 3.6-.6-3-3.5-3.6 2.9-.6 3.5-3.6z
    M33 118q.6 3 3.5 3.6-2.9.6-3.5 3.6-.6-3-3.5-3.6 2.9-.6 3.5-3.6z"/>
  <g opacity=".14">
    <circle cx="27" cy="58" r=".9"/><circle cx="65" cy="24" r="1.1"/><circle cx="94" cy="28" r=".6"/>
    <circle cx="155" cy="22" r=".7"/><circle cx="193" cy="39" r=".9"/><circle cx="61" cy="130" r=".8"/>
    <circle cx="176" cy="149" r="1"/><circle cx="187" cy="139" r=".6"/>
  </g>
</g>`;

const leaves = `<path opacity=".18" d="
  M93 29C95 24 101 22 107 23C104 28 99 31 93 29Z
  M42 66C44 61 50 59 56 60C53 65 48 68 42 66Z"/>`;

// Both renderers accept eight-digit hex stops. The default tint fades from 10% through 4% to clear.
function headerGradient(color: string, top = "1a", middle = "0a") {
  return `linear-gradient(to bottom, ${color}${top}, ${color}${middle} 50%, ${color}00)`;
}

export const sidebarIdentity = {
  development: {
    label: "Dev",
    tone: "sky",
    gradient: headerGradient(palette.zinc[500], "14", "08"),
    ink: { light: palette.blue[700], dark: palette.blue[300] },
    art: scene(
      "dev",
      `<g fill-opacity=".025" stroke="currentColor" stroke-opacity=".17" stroke-width="1" stroke-linejoin="round">${tree}</g>`,
      guides,
    ),
  },
  nightly: {
    label: "Nightly",
    tone: "violet",
    gradient: headerGradient(palette.violet[500]),
    ink: { light: palette.violet[700], dark: palette.violet[300] },
    art: scene("nightly", `<g opacity=".085">${tree}</g>`, stars),
  },
  beta: {
    label: "Beta",
    tone: "amber",
    gradient: headerGradient(palette.amber[500]),
    ink: { light: palette.amber[700], dark: palette.amber[300] },
    art: scene("beta", `<g opacity=".09">${tree}</g>`, leaves),
  },
  stable: {
    label: "Stable",
    tone: "emerald",
    gradient: undefined,
    ink: { light: "#194a34", dark: "#dfecd0" },
    art: scene("stable", `<g opacity=".07">${tree}</g>`),
  },
} as const;

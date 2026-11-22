import { canopyTree } from "./canopy-tree.ts";
import { palette } from "./tokens.ts";

const tree = `<path fill-rule="evenodd" d="${canopyTree.outline}"/>`;

export const sidebarIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#edf0e4"/>
  <g transform="translate(6.58 17.65) scale(.66)" fill="#194a34">${tree}</g>
</svg>`;

// The square art meets the pane's right edge. The crown continues beyond that edge in all four scenes.
function scene(drawing: string, surroundings = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 200 200" preserveAspectRatio="xMaxYMid meet" fill="currentColor">
    ${surroundings}
    <g transform="translate(32 18) scale(1.18)">${drawing}</g>
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
    M53 29q.8 4.8 5 5.5-4.2.7-5 5.5-.8-4.8-5-5.5 4.2-.7 5-5.5z
    M177 5q.6 3 3.5 3.6-2.9.6-3.5 3.6-.6-3-3.5-3.6 2.9-.6 3.5-3.6z
    M33 118q.6 3 3.5 3.6-2.9.6-3.5 3.6-.6-3-3.5-3.6 2.9-.6 3.5-3.6z"/>
  <g opacity=".14">
    <circle cx="27" cy="58" r=".9"/><circle cx="78" cy="18" r="1.1"/><circle cx="94" cy="28" r=".6"/>
    <circle cx="150" cy="7" r=".7"/><circle cx="189" cy="21" r=".9"/><circle cx="61" cy="130" r=".8"/>
    <circle cx="176" cy="149" r="1"/><circle cx="187" cy="139" r=".6"/>
  </g>
</g>`;

const hatching = `<path transform="translate(4 -14.5)" fill="none" stroke="currentColor" stroke-width=".9"
  stroke-linecap="round" opacity=".12" d="
    M6 67.3Q9.1 62.5 12.3 57.8 M9.9 79.3Q23.9 56 42.2 32.8 M17.9 85Q33 58.9 53.6 32.8
    M28.8 85.8Q48.9 51 78.6 16.3 M40.8 84.8Q60.3 51.1 88.9 17.5 M55 80Q72.6 50.8 96.9 21.5
    M68.8 76Q83.8 51.8 103.4 27.5 M80.9 75Q94.1 53.6 111 32.3 M92.3 75Q105.2 54.1 121.6 33.3
    M102.9 76.3Q114.8 56.9 129.7 37.5 M112.5 79.3Q123.1 61.6 136.2 44 M121.6 83Q130.1 68.5 140.4 54
    M131.7 85.3Q139.7 71.5 149.1 57.8 M142.8 85.8Q149.2 74.8 156.5 63.8 M156 82.8Q158 79.4 160 76"/>`;

const leaves = `<path opacity=".15" d="M59 121q3-7 11-7-3 7-11 7z M47 138q-1-6 4-10 2 6-4 10z"/>`;

export const sidebarIdentity = {
  development: {
    label: "Dev",
    tone: "sky",
    ink: { light: palette.blue[700], dark: palette.blue[300] },
    art: scene(
      `<g fill-opacity=".025" stroke="currentColor" stroke-opacity=".17" stroke-width="1" stroke-linejoin="round">${tree}</g>`,
      guides,
    ),
  },
  nightly: {
    label: "Nightly",
    tone: "violet",
    ink: { light: palette.violet[700], dark: palette.violet[300] },
    art: scene(`<g opacity=".085">${tree}</g>`, stars),
  },
  beta: {
    label: "Beta",
    tone: "amber",
    ink: { light: palette.amber[700], dark: palette.amber[300] },
    art: scene(
      `<path fill-rule="evenodd" opacity=".085" d="${canopyTree.branches}"/>
       <path fill-opacity=".035" stroke="currentColor" stroke-width=".85" stroke-opacity=".13" d="${canopyTree.crown}"/>
       ${hatching}`,
      leaves,
    ),
  },
  stable: {
    label: "Stable",
    tone: "emerald",
    ink: { light: "#194a34", dark: "#dfecd0" },
    art: scene(`<g opacity=".07">${tree}</g>`),
  },
} as const;

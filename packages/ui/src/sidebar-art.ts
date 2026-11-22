import { canopyTree } from "./canopy-tree.ts";
import { palette } from "./tokens.ts";

const tree = `<path fill-rule="evenodd" d="${canopyTree.outline}"/>`;

export const sidebarIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#edf0e4"/>
  <g transform="translate(6.58 17.65) scale(.66)" fill="#194a34">${tree}</g>
</svg>`;

// All four scenes use the same tree at the same scale. The host supplies the ink for its colour scheme.
function scene(drawing: string, surroundings = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 160 88" fill="currentColor">
    ${surroundings}
    <g transform="translate(83 4.5) scale(.275)">${drawing}</g>
  </svg>`;
}

const guides = `<g fill="none" stroke="currentColor">
  <path opacity=".13" stroke-width=".65" d="
    M42 8h105 M34 18h120 M30 28h128 M36 38h117 M47 48h99 M62 58h75
    M47 12v30 M57 6v43 M67 3v52 M77 2v58 M87 1v60 M97 1v62 M107 0v64 M117 1v61 M127 3v56 M137 5v49 M147 12v32"/>
  <path opacity=".38" stroke-width=".8" stroke-dasharray="2.5 2.5" d="M107 0v49 M75 21h58"/>
  <path opacity=".52" stroke-width=".85" d="
    M79 17v8m-4-4h8 M148 4.5h7m-7 39h7 M152 4.5v39 M150 6.5l4-4m-4 43 4-4"/>
</g>`;

const stars = `<g>
  <path opacity=".68" d="
    M62 9q.8 4.5 5 5-4.2.8-5 5-.7-4.2-5-5 4.3-.5 5-5z
    M143 16q.7 3.6 4.1 4.2-3.4.5-4.1 4.3-.6-3.8-4.1-4.3 3.5-.6 4.1-4.2z
    M126 3l.8 2.2 2.2.8-2.2.8L126 9l-.8-2.2L123 6l2.2-.8z"/>
  <g opacity=".48">
    <circle cx="45" cy="29" r="1.1"/><circle cx="74" cy="6" r=".9"/><circle cx="79" cy="23" r="1.2"/>
    <circle cx="120" cy="38" r="1"/><circle cx="136" cy="33" r="1.3"/><circle cx="153" cy="9" r=".85"/>
  </g>
</g>`;

const hatching = `<path transform="translate(4 -14.5)" fill="none" stroke="currentColor" stroke-width="3"
  stroke-linecap="round" opacity=".58" d="
    M6 67.3Q9.1 62.5 12.3 57.8 M9.9 79.3Q23.9 56 42.2 32.8 M17.9 85Q33 58.9 53.6 32.8
    M28.8 85.8Q48.9 51 78.6 16.3 M40.8 84.8Q60.3 51.1 88.9 17.5 M55 80Q72.6 50.8 96.9 21.5
    M68.8 76Q83.8 51.8 103.4 27.5 M80.9 75Q94.1 53.6 111 32.3 M92.3 75Q105.2 54.1 121.6 33.3
    M102.9 76.3Q114.8 56.9 129.7 37.5 M112.5 79.3Q123.1 61.6 136.2 44 M121.6 83Q130.1 68.5 140.4 54
    M131.7 85.3Q139.7 71.5 149.1 57.8 M142.8 85.8Q149.2 74.8 156.5 63.8 M156 82.8Q158 79.4 160 76"/>`;

const leaves = `<path opacity=".48" d="M132 9q3-7 10-7-2 6-10 7z M142 34q0-6 5-9 1 6-5 9z"/>`;

export const sidebarIdentity = {
  development: {
    label: "Dev",
    tone: "sky",
    ink: { light: palette.blue[700], dark: palette.blue[300] },
    art: scene(
      `<g fill-opacity=".06" stroke="currentColor" stroke-opacity=".68" stroke-width="3.3" stroke-linejoin="round">${tree}</g>`,
      guides,
    ),
  },
  nightly: {
    label: "Nightly",
    tone: "violet",
    ink: { light: palette.violet[700], dark: palette.violet[300] },
    art: scene(`<g opacity=".36">${tree}</g>`, stars),
  },
  beta: {
    label: "Beta",
    tone: "amber",
    ink: { light: palette.amber[700], dark: palette.amber[300] },
    art: scene(
      `<path fill-rule="evenodd" opacity=".47" d="${canopyTree.branches}"/>
       <path fill-opacity=".1" stroke="currentColor" stroke-width="2.9" stroke-opacity=".5" d="${canopyTree.crown}"/>
       ${hatching}`,
      leaves,
    ),
  },
  stable: {
    label: "Stable",
    tone: "emerald",
    ink: { light: "#194a34", dark: "#dfecd0" },
    art: scene(`<g opacity=".25">${tree}</g>`),
  },
} as const;

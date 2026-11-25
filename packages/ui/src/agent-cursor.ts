// Logical points measured from the hotspot. WindowServer, SVG and React Native
// draw the same rounded silhouette using the rim underneath the blue fill.
const points = [
  [0, 0],
  [28.6, 17.5],
  [11.7, 18.7],
  [3.2, 33.4],
] as const;

export const agentCursor = {
  points,
  path: `M${points.map(([x, y]) => `${x} ${y}`).join(" L")} Z`,
  fill: "#4299FF",
  rim: "#111318",
  rimStroke: 6.5,
  fillStroke: 3,
  shadow: { x: 2.5, y: 3, blur: 5, opacity: 0.34 },
} as const;

export const videoControlGlyphs = {
  play: ["M6 4v16a1 1 0 0 0 1.524.852l13-8a1 1 0 0 0 0-1.704l-13-8A1 1 0 0 0 6 4"],
  pause: [
    "M9 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2",
    "M17 4h-2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2",
  ],
  replay: ["M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5"],
  volume: [
    "M15 8a5 5 0 0 1 0 8",
    "M17.7 5a9 9 0 0 1 0 14",
    "M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5z",
  ],
  muted: [
    "M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5z",
    "m16 10l4 4m0-4l-4 4",
  ],
  captions: [
    "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M10 10.5a1.5 1.5 0 0 0-3 0v3a1.5 1.5 0 0 0 3 0m7-3a1.5 1.5 0 0 0-3 0v3a1.5 1.5 0 0 0 3 0",
  ],
  enter: ["M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2m8-16h2a2 2 0 0 1 2 2v2m-4 12h2a2 2 0 0 0 2-2v-2"],
  exit: ["M15 19v-2a2 2 0 0 1 2-2h2M15 5v2a2 2 0 0 0 2 2h2M5 15h2a2 2 0 0 1 2 2v2M5 9h2a2 2 0 0 0 2-2V5"],
} as const;

export type VideoControlGlyph = keyof typeof videoControlGlyphs;

export const VIDEO_CONTROLS_IDLE_MS = 2_500;

export function videoClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.floor(Math.max(0, seconds)) : 0;

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

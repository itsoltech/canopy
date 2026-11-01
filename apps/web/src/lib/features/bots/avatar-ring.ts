/**
 * Ring around an avatar (or a badge on it) in the colour of the surface behind it, so overlapping
 * avatars and badges look cut out. Surfaces other than white / black set `--avatar-ring`.
 */
export const avatarRing = "ring-2 ring-[var(--avatar-ring,var(--color-white))] dark:ring-[var(--avatar-ring,var(--color-black))]";

/** Expanded empty thread composer, excluding safe area, keyboard, fade and floating status rows. */
export const composerGeometry = {
  input: 64,
  // The 36 dp attach button plus 10 dp padding on each side exceeds the toolbar's former 52 dp minimum.
  toolbar: 56,
  secondary: 36,
  padding: 20,
  gap: 8,
  border: 2,
};

export const threadComposerHeight = Object.values(composerGeometry).reduce((sum, size) => sum + size, 0);

/** Only the latest-button anchor; the scroll reserve uses the measured whole stack. */
export const collapsedThreadComposerHeight =
  44 + composerGeometry.border + composerGeometry.padding + composerGeometry.gap;

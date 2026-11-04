const key = "canopy.animated-mascots";
const changed = "canopy:animated-mascots";

/** Device-local preference: no gateway contract changes, defaults on even without storage access. */
export function animatedMascots(): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

export function setAnimatedMascots(enabled: boolean): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    /* Still applies to this tab. */
  }

  window.dispatchEvent(new CustomEvent<boolean>(changed, { detail: enabled }));
}

export function watchAnimatedMascots(callback: (enabled: boolean) => void): () => void {
  const local = (event: Event) => callback((event as CustomEvent<boolean>).detail);

  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) callback(animatedMascots());
  };

  callback(animatedMascots());
  window.addEventListener(changed, local);
  window.addEventListener("storage", storage);

  return () => {
    window.removeEventListener(changed, local);
    window.removeEventListener("storage", storage);
  };
}

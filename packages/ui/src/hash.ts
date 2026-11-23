/** 32-bit FNV-1a over UTF-16 code units, stable across JavaScript runtimes. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}

/** Both whitespace-only deltas and model-like tokens with leading or trailing spaces. */
export const boundaryChunks = ["Final QA passed: all", " 4", " views, overflow", " 0", ". ", "Typecheck", " 0/0", "\n"];

export const busText =
  boundaryChunks.join("") +
  "\u00a016\u00a0zgodnych WebP i\u202f2800x1750\r\n8\u2009raw\u2007PNG\n" +
  "main\tprośba,  fold plan\n\n- z\u00a0open panel\n- w\u2009projekcie i\u202f3 konta\n\n" +
  "```ts\n\tconst text = 'Po\u00a0ostatnim copy FREEZE';\n```\nNie build typecheck\u202f";

export const textChunks = [...boundaryChunks, ...busText.slice(boundaryChunks.join("").length)];

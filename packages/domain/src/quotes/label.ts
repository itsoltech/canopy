/** Cheap display-only cleanup: chip labels must not lex a whole markdown document. */
export function citationPlainText(text: string): string {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?)/gm, "")
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^ {0,3}(?:=+|-+)\s*$/gm, "")
    .replace(/!?\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g, "$1$2")
    .replace(/~~([\s\S]+?)~~/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
    .replace(/\\([\\`*{}[\]()#+.!_>~-])/g, "$1")
    .trim();
}

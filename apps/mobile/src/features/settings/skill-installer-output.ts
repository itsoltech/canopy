const maxLines = 240;
const maxColumns = 320;

type Escape = "text" | "escape" | "intermediate" | "csi" | "string" | "string-end";

/** Keeps a bounded, plain-text console and redraws the lines used by installer prompts. */
export class SkillInstallerOutput {
  #decoder = new TextDecoder();
  #lines: string[][] = [[]];
  #row = 0;
  #column = 0;
  #escape: Escape = "text";
  #parameters = "";
  truncated = false;

  constructor(readonly screenRows: number) {}

  append(bytes: Uint8Array, skipped: boolean, running: boolean): string {
    if (skipped) {
      this.#decoder = new TextDecoder();
      this.#lines = [[]];
      this.#row = 0;
      this.#column = 0;
      this.#escape = "text";
      this.truncated = true;
    }

    for (const character of this.#decoder.decode(bytes, { stream: running })) {
      if (this.#escape === "text") this.#print(character);
      else this.#sequence(character);
    }

    return this.#lines
      .map((line) => line.join("").trimEnd())
      .join("\n")
      .trimEnd();
  }

  #print(character: string) {
    switch (character) {
      case "\x1b":
        this.#escape = "escape";
        break;
      case "\r":
        this.#column = 0;
        break;
      case "\n":
        this.#move(this.#row + 1, 0);
        break;
      case "\b":
        this.#column = Math.max(0, this.#column - 1);
        break;
      case "\t":
        this.#column = Math.min(maxColumns, (Math.floor(this.#column / 8) + 1) * 8);
        break;
      default:
        if (character < " " || (character >= "\x7f" && character <= "\x9f")) return;

        if (this.#column < maxColumns) {
          const line = this.#line();

          while (line.length < this.#column) line.push(" ");
          line[this.#column++] = character;
        } else this.truncated = true;
    }
  }

  #sequence(character: string) {
    switch (this.#escape) {
      case "escape":
        if (character === "[") {
          this.#parameters = "";
          this.#escape = "csi";
        } else if ("]P^_X".includes(character)) this.#escape = "string";
        else this.#escape = character >= " " && character <= "/" ? "intermediate" : "text";
        break;
      case "intermediate":
        if (character >= "0") this.#escape = "text";
        break;
      case "csi":
        if (character === "\x1b") this.#escape = "escape";
        else if (character >= "@" && character <= "~") {
          this.#escape = "text";

          if (/^[\d;]{0,24}$/.test(this.#parameters)) this.#control(character, this.#parameters.split(";").map(Number));
        } else if (this.#parameters.length <= 24) this.#parameters += character;
        break;
      case "string":
        if (character === "\x07") this.#escape = "text";
        else if (character === "\x1b") this.#escape = "string-end";
        break;
      case "string-end":
        this.#escape = character === "\\" || character === "\x07" ? "text" : "string";
        break;
    }
  }

  #control(code: string, [mode = 0, column = 0]: number[]) {
    const steps = Math.min(mode || 1, maxColumns);
    const top = Math.max(0, this.#lines.length - this.screenRows);

    switch (code) {
      case "A":
      case "F":
        this.#move(Math.max(top, this.#row - steps), code === "F" ? 0 : this.#column);
        break;
      case "B":
      case "E":
        this.#move(Math.min(top + this.screenRows - 1, this.#row + steps), code === "E" ? 0 : this.#column);
        break;
      case "C":
        this.#move(this.#row, this.#column + steps);
        break;
      case "D":
        this.#move(this.#row, this.#column - steps);
        break;
      case "G":
        this.#move(this.#row, steps - 1);
        break;
      case "H":
      case "f":
        this.#move(top + Math.min(steps, this.screenRows) - 1, (column || 1) - 1);
        break;
      case "K": {
        const line = this.#line();

        if (mode === 1) line.fill(" ", 0, this.#column + 1);
        else line.length = mode === 2 ? 0 : Math.min(this.#column, line.length);
        break;
      }

      case "J":
        if (mode === 2) {
          for (let row = top; row < this.#lines.length; row++) this.#lines[row] = [];
        } else if (mode === 0) {
          const line = this.#line();
          line.length = Math.min(this.#column, line.length);
          this.#lines.length = this.#row + 1;
        }

        break;
    }
  }

  #line() {
    while (this.#lines.length <= this.#row) this.#lines.push([]);

    return (this.#lines[this.#row] ??= []);
  }

  #move(row: number, column: number) {
    // Clear old rows in batches when a command prints large amounts of output.
    if (row >= maxLines) {
      const drop = maxLines / 4;
      this.#lines.splice(0, drop);
      row -= drop;
      this.truncated = true;
    }

    this.#row = row;
    this.#column = Math.min(maxColumns, Math.max(0, column));
    this.#line();
  }
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string) => escapeHtml(text).replaceAll('"', "&quot;");

/** Only web links and Telegram user mentions become anchors; anything else stays visible text. */
const safeLink = /^(https?:\/\/[^\s<>"]+|tg:\/\/user\?id=\d{1,20})$/;

function inline(text: string): string {
  const codes: string[] = [];

  const marked = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);

    return `\uE000${codes.length - 1}\uE000`;
  });

  return escapeHtml(marked)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
      const target = url.replaceAll("&amp;", "&");

      return safeLink.test(target) ? `<a href="${escapeAttribute(target)}">${label}</a>` : match;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>")
    .replace(/\uE000(\d+)\uE000/g, (_, index: string) => codes[Number(index)] ?? "");
}

function line(text: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(text);

  if (heading) return `<b>${inline(heading[1] ?? "")}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);

  if (bullet) return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`;

  return inline(text);
}

/** Converts the bot's Markdown to the HTML subset Telegram accepts with parse_mode=HTML. */
export function formatTelegramMessage(markdown: string): string {
  const output: string[] = [];
  const lines = markdown.split("\n");
  let quote: string[] = [];

  const flushQuote = () => {
    if (quote.length) output.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const current = lines[index] ?? "";
    const fence = /^```(\w*)\s*$/.exec(current);

    if (fence) {
      flushQuote();
      const end = lines.findIndex((candidate, at) => at > index && /^```\s*$/.test(candidate));
      const body = lines.slice(index + 1, end === -1 ? lines.length : end).join("\n");
      const language = fence[1] ? ` class="language-${fence[1]}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(body)}</code></pre>`);
      index = end === -1 ? lines.length : end;
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(current);

    if (quoted) {
      quote.push(line(quoted[1] ?? ""));
      continue;
    }

    flushQuote();
    output.push(line(current));
  }

  flushQuote();

  return output.join("\n");
}

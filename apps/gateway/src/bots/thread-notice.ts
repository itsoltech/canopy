/** Bound the title in local watch input and its visible notice, including titles from older threads. */
export function botThreadNoticeTitle(title: string): string {
  const limit = 200;

  return title.length <= limit ? title : `${title.slice(0, limit - 1).replace(/\p{Surrogate}$/u, "")}…`;
}

/** Short event text, separate from the model's completion report and its transcript. */
export function threadNotice(title: string, status: string, computer = "", failure = ""): string {
  const subject = `“${title || "Thread"}”${computer ? ` on ${computer}` : ""}`;

  switch (status) {
    case "completed":
      return `${subject} finished`;
    case "failed":
      return failure ? `${failure} (${subject})` : `${subject} failed`;
    case "interrupted":
      return `${subject} was interrupted`;
    case "cancelled":
      return `${subject} was cancelled`;
    default:
      return `${subject} ended`;
  }
}

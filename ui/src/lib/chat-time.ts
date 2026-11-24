import { formatDistanceToNow } from "date-fns";

/** Like formatDistanceToNow but "just now" under 30 s: the time under a chat message. */
export function chatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 30_000) return "just now";
  return formatDistanceToNow(date, { addSuffix: true });
}

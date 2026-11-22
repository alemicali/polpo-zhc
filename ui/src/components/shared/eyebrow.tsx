import { cn } from "@/lib/utils";

/**
 * A small label / eyebrow: caption size, semibold, the look's label case and tracking
 * (the text-label utility), muted. Use it for group titles, field captions, table column headers,
 * the line above a page title — anything that was `text-[10px] uppercase tracking-wider`.
 */
export function Eyebrow({ as: Tag = "div", className, ...props }: React.HTMLAttributes<HTMLElement> & {
  as?: "div" | "span" | "p" | "h2" | "h3" | "h4" | "label" | "dt";
}) {
  return <Tag data-slot="eyebrow" className={cn("text-label text-muted-foreground", className)} {...props} />;
}

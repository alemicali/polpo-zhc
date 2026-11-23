import { Check, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { DocComment } from "./artifact-doc-comments";

export function DocumentComment({ comment, onToggle }: { comment: DocComment; onToggle?: () => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button"
          aria-label={comment.resolved ? "Open resolved comment" : "Open comment"}
          title={comment.resolved ? "Resolved comment" : "Comment"}
          className={`inline-flex size-5 items-center justify-center rounded-md border align-middle outline-none focus-visible:ring-2 focus-visible:ring-ring ${comment.resolved
            ? "border-border bg-muted text-muted-foreground hover:bg-accent"
            : "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"}`}>
          <MessageSquare className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1.5rem)]">
        <PopoverHeader><PopoverTitle>{comment.resolved ? "Resolved comment" : "Document comment"}</PopoverTitle></PopoverHeader>
        {comment.quote && (
          <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-warning pl-2 text-xs text-muted-foreground">
            {comment.quote}
          </blockquote>
        )}
        <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{comment.body}</p>
        {onToggle && <div className="flex justify-end">
          <Button type="button" size="sm" variant="outline" onClick={onToggle}>
            {comment.resolved ? <RotateCcw /> : <Check />}
            {comment.resolved ? "Reopen" : "Resolve"}
          </Button>
        </div>}
      </PopoverContent>
    </Popover>
  );
}

import { Check, MessageSquare, RotateCcw } from "lucide-react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { decodeDocComment, encodeDocComment } from "./artifact-doc-comments";

export function DocCommentMarker({ node, updateAttributes }: NodeViewProps) {
  const comment = decodeDocComment(node.attrs.comment);
  if (!comment) return <NodeViewWrapper as="span" contentEditable={false} aria-hidden="true" />;
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="mx-0.5 inline-block align-baseline">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button"
            aria-label={comment.resolved ? "Open resolved comment" : "Open comment"}
            title={comment.resolved ? "Resolved comment" : "Comment"}
            className={`inline-flex size-5 items-center justify-center rounded-md border align-middle outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${comment.resolved
              ? "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
              : "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"}`}>
            <MessageSquare className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="artifact-doc-surface w-72 max-w-[calc(100vw-1.5rem)]">
          <PopoverHeader><PopoverTitle>{comment.resolved ? "Resolved comment" : "Document comment"}</PopoverTitle></PopoverHeader>
          {comment.quote && (
            <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">
              {comment.quote}
            </blockquote>
          )}
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{comment.body}</p>
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => {
              updateAttributes({ comment: encodeDocComment({ ...comment, resolved: !comment.resolved }) });
            }}>
              {comment.resolved ? <RotateCcw /> : <Check />}
              {comment.resolved ? "Reopen" : "Resolve"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

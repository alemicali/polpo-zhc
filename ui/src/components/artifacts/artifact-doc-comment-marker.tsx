import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { DocumentComment } from "./artifact-doc-comment";
import { decodeDocComment, encodeDocComment } from "./artifact-doc-comments";

export function DocCommentMarker({ node, updateAttributes }: NodeViewProps) {
  const comment = decodeDocComment(node.attrs.comment);
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="mx-0.5 inline-block align-baseline">
      {comment && <DocumentComment comment={comment} onToggle={() =>
        updateAttributes({ comment: encodeDocComment({ ...comment, resolved: !comment.resolved }) })} />}
    </NodeViewWrapper>
  );
}

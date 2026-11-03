// Connection of the playbook editor: highlighted when selected, with a button that removes it.
// Its ends can be dragged to another node (ReactFlow edgesReconnectable + onReconnect).

import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

export function EditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
  interactionWidth,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        style={selected ? { ...style, stroke: "var(--primary)", strokeWidth: 2.5 } : style}
      />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Remove connection"
            title="Remove connection (Delete)"
            className="nodrag nopan pointer-events-auto absolute flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-colors hover:border-destructive hover:bg-destructive hover:text-white"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            // Through deleteElements, so it goes the same way as the Delete key (the editor's onDelete).
            onClick={(e) => { e.stopPropagation(); void deleteElements({ edges: [{ id }] }); }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

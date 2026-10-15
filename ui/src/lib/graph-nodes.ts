import type { Node } from "@xyflow/react";

/**
 * A rebuilt node with the size React Flow already measured for the node it replaces. React Flow
 * hides a node whose size is unknown and measures it again only when its size changes, so a graph
 * rebuilt from scratch (new node objects, same sizes) stayed invisible, edges included.
 */
export function withMeasured(node: Node, previous: Node | undefined): Node {
  return previous?.measured && !node.measured ? { ...node, measured: previous.measured } : node;
}

/**
 * SegmentLine — renders a Seg[] array as styled <Text> elements.
 * Single source of truth for segment rendering across all components.
 */

import { Text } from "ink";
import type { Seg } from "../store.js";

export function SegmentLine({ segs }: { segs: Seg[] }) {
  return (
    <Text>
      {segs.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          bold={s.bold}
          dimColor={s.dim}
          backgroundColor={s.bgColor}
          underline={s.underline}
          italic={s.italic}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

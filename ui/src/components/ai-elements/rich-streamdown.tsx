import type { ComponentProps } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

const plugins = { cjk, code, math, mermaid };

export function RichStreamdown(props: ComponentProps<typeof Streamdown>) {
  return <Streamdown plugins={plugins} {...props} />;
}

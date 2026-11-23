import { Extension, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const blankDocContent: JSONContent = {
  type: "doc",
  content: [{ type: "heading", attrs: { level: 1 } }, { type: "paragraph" }],
};

export const DocEmptyHints = Extension.create<{
  ask: () => void;
  canAsk: boolean;
  instanceName: string;
}>({
  name: "docEmptyHints",
  addOptions() {
    return { ask: () => undefined, canAsk: false, instanceName: "Polpo" };
  },
  addProseMirrorPlugins() {
    const settings = this.options;
    return [new Plugin({
      key: new PluginKey("docEmptyHints"),
      props: {
        decorations(state) {
          const items: Decoration[] = [];
          const title = state.doc.firstChild;
          if (title?.type.name !== "heading" || title.attrs.level !== 1) return null;
          if (!title.content.size) items.push(Decoration.node(0, title.nodeSize, { "data-doc-placeholder": "Title" }));

          const body = state.doc.childCount === 2 ? state.doc.lastChild : null;
          if (body?.type.name === "paragraph" && !body.content.size) {
            items.push(Decoration.widget(title.nodeSize + 1, () => {
              const hint = document.createElement("span");
              hint.contentEditable = "false";
              hint.className = "inline-flex flex-wrap items-baseline gap-x-1 select-none text-neutral-500";
              if (!settings.canAsk) {
                hint.textContent = "Start writing…";
                return hint;
              }
              hint.append("Start typing, or ask ");
              const ask = document.createElement("button");
              ask.type = "button";
              ask.className = "cursor-pointer rounded-sm font-medium text-neutral-700 underline decoration-slate-300 underline-offset-2 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-blue-600";
              ask.textContent = `@${settings.instanceName}`;
              ask.addEventListener("mousedown", (event) => event.preventDefault());
              ask.addEventListener("click", settings.ask);
              hint.append(ask, " to write");
              return hint;
            }, { ignoreSelection: true, side: 1, key: "doc-writing-hint" }));
          }
          return DecorationSet.create(state.doc, items);
        },
      },
    })];
  },
});

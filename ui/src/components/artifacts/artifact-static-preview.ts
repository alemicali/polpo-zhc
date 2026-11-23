import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";

const removedTags = new Set(["base", "embed", "frame", "frameset", "iframe", "link", "meta", "noscript", "object", "script", "template"]);
const preservedAttributes = new Set([
  "class", "id", "style", "lang", "dir", "width", "height", "colspan", "rowspan", "open", "type", "value", "placeholder",
  "checked", "selected", "disabled", "alt", "role", "viewbox", "d", "points", "fill", "fill-opacity", "stroke",
  "stroke-width", "stroke-opacity", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "rx", "ry", "r", "transform",
]);
const embeddedImage = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/]+=*$/i;

function makeStatic(node: DefaultTreeAdapterTypes.ParentNode) {
  node.childNodes = node.childNodes.filter((child) => {
    if (!("tagName" in child)) return child.nodeName !== "#documentType";
    if (removedTags.has(child.tagName.toLowerCase())) return false;
    child.attrs = child.attrs.filter(({ name, value }) =>
      preservedAttributes.has(name.toLowerCase()) ||
      (child.tagName === "img" && name === "src" && embeddedImage.test(value)),
    );
    makeStatic(child);
    return true;
  });
}

/** An inert excerpt confined to a sandbox with a restrictive document policy. */
export function artifactStaticPreview(content: string): string {
  const document = parse(content);
  makeStatic(document);
  const markup = serialize(document);
  return [
    "<!doctype html>",
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">',
    "<style>html,body{overflow:hidden!important}</style>",
    markup,
  ].join("");
}

(function () {
  "use strict";

  if (window.__polpoAppPreviewBridge) return;
  window.__polpoAppPreviewBridge = true;

  var enabled = false;
  var hovered = null;
  var raf = 0;
  var pendingEvent = null;
  var box = document.createElement("div");
  var label = document.createElement("div");
  var cursorStyle = document.createElement("style");

  box.setAttribute("data-polpo-preview-overlay", "");
  Object.assign(box.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    zIndex: "2147483646",
    border: "2px solid #06b6d4",
    background: "rgba(6, 182, 212, 0.12)",
    boxSizing: "border-box",
  });
  Object.assign(label.style, {
    position: "absolute",
    left: "-2px",
    bottom: "100%",
    maxWidth: "320px",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    padding: "3px 6px",
    background: "#0891b2",
    color: "#fff",
    font: "500 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace",
  });
  cursorStyle.textContent = "html[data-polpo-preview-picking] *, html[data-polpo-preview-picking] { cursor: crosshair !important; }";
  box.appendChild(label);

  function mount() {
    if (!document.documentElement.contains(cursorStyle)) document.head.appendChild(cursorStyle);
    if (!document.documentElement.contains(box)) document.body.appendChild(box);
  }

  function quote(value) {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  function selectorFor(target) {
    if (target.id) return "#" + CSS.escape(target.id);
    var testId = target.getAttribute("data-testid");
    if (testId) return '[data-testid="' + quote(testId) + '"]';
    var path = [];
    var current = target;
    while (current && current !== document.body && path.length < 7) {
      var part = current.tagName.toLowerCase();
      var name = current.getAttribute("name");
      if (name) {
        part += '[name="' + quote(name) + '"]';
        path.unshift(part);
        break;
      }
      var parent = current.parentElement;
      var siblings = parent
        ? Array.from(parent.children).filter(function (item) { return item.tagName === current.tagName; })
        : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      path.unshift(part);
      current = parent;
    }
    return path.join(" > ");
  }

  function serialize(element) {
    var rect = element.getBoundingClientRect();
    var names = ["id", "class", "name", "role", "aria-label", "data-testid", "href", "type"];
    var attributes = {};
    names.forEach(function (name) {
      var value = element.getAttribute(name);
      if (value !== null) attributes[name] = value;
    });
    return {
      tagName: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      text: (element.innerText || element.textContent || "").trim().slice(0, 500),
      attributes: attributes,
      outerHTML: element.outerHTML.slice(0, 2000),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function elementAt(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    var candidate = path.find(function (item) {
      return item instanceof HTMLElement && !item.hasAttribute("data-polpo-preview-overlay");
    });
    return candidate || document.elementFromPoint(event.clientX, event.clientY);
  }

  function draw(element) {
    if (!(element instanceof HTMLElement)) {
      box.style.display = "none";
      return;
    }
    var rect = element.getBoundingClientRect();
    var selector = selectorFor(element);
    box.style.display = "block";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    label.textContent = selector;
    hovered = element;
    window.parent.postMessage({ type: "polpo:app-preview-node-hovered", node: serialize(element) }, "*");
  }

  function onPointerMove(event) {
    if (!enabled) return;
    pendingEvent = event;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      if (!pendingEvent || !enabled) return;
      draw(elementAt(pendingEvent));
      pendingEvent = null;
    });
  }

  function onClick(event) {
    if (!enabled) return;
    var element = elementAt(event) || hovered;
    if (!(element instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.parent.postMessage({ type: "polpo:app-preview-node-selected", node: serialize(element) }, "*");
    hovered = null;
    pendingEvent = null;
    box.style.display = "none";
  }

  function onKeyDown(event) {
    if (!enabled || event.key !== "Escape") return;
    event.preventDefault();
    setEnabled(false);
    window.parent.postMessage({ type: "polpo:app-preview-picker-cancelled" }, "*");
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    mount();
    document.documentElement.toggleAttribute("data-polpo-preview-picking", enabled);
    if (!enabled) {
      hovered = null;
      box.style.display = "none";
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "polpo:app-preview-inspector") setEnabled(event.data.enabled);
    if (event.data.type === "polpo:app-preview-ping") {
      window.parent.postMessage({ type: "polpo:app-preview-bridge-ready", version: 1 }, "*");
    }
    if (event.data.type === "polpo:app-preview-theme") {
      var theme = event.data.resolvedTheme;
      if (theme !== "light" && theme !== "dark") return;
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.classList.toggle("light", theme === "light");
      document.documentElement.style.colorScheme = theme;
    }
  });

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);

  function ready() {
    mount();
    window.parent.postMessage({ type: "polpo:app-preview-bridge-ready", version: 1 }, "*");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();

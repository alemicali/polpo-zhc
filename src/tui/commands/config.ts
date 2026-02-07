/**
 * /config command — adapter, model selection menus.
 */

import blessed from "blessed";
import type { CommandContext } from "../context.js";
import type { ProviderOption } from "../constants.js";
import { PROVIDERS, MODELS } from "../constants.js";
import { getProviderLabel } from "../formatters.js";
import { createOverlay, addHintBar } from "../widgets.js";

export function cmdConfig(ctx: CommandContext): void {
  showConfigMenu(ctx);
}

function showConfigMenu(ctx: CommandContext): void {
  const { overlay, cleanup } = createOverlay(ctx);

  const modelLabel = ctx.config.model
    ? MODELS.find(m => m.value === ctx.config.model)?.label ?? ctx.config.model
    : "default";

  const configItems = [
    `  {cyan-fg}Judge{/cyan-fg}      ${getProviderLabel(ctx.config.judge)}`,
    `  {cyan-fg}Agent{/cyan-fg}      ${getProviderLabel(ctx.config.agent)}`,
    `  {cyan-fg}Model{/cyan-fg}      ${modelLabel}`,
  ];

  const configBox = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: 50,
    height: configItems.length + 2,
    items: configItems,
    tags: true,
    border: { type: "line" },
    label: " {yellow-fg}♩{/yellow-fg} {bold}Configuration{/bold} ",
    style: {
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: true,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}change{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}");

  configBox.select(0);
  configBox.focus();
  ctx.scheduleRender();

  let cfgReady = false;
  setImmediate(() => { cfgReady = true; });
  configBox.on("select", (_item: any, index: number) => {
    if (!cfgReady) return;
    if (index === 0) {
      showConfigPicker(ctx, overlay, "Select Judge", PROVIDERS, (value) => {
        ctx.config.judge = value;
        cleanup();
        ctx.log(`{green-fg}Judge changed to ${getProviderLabel(value)}{/green-fg}`);
      }, cleanup);
    } else if (index === 1) {
      showConfigPicker(ctx, overlay, "Select Agent", PROVIDERS, (value) => {
        ctx.config.agent = value;
        const team = ctx.orchestrator.getTeam();
        for (const a of team.agents) {
          a.adapter = value;
        }
        cleanup();
        ctx.log(`{green-fg}Agent changed to ${getProviderLabel(value)}{/green-fg}`);
        const validModels = MODELS.filter(m => m.adapter === value);
        if (validModels.length > 0 && !validModels.find(m => m.value === ctx.config.model)) {
          ctx.config.model = validModels[0].value;
          ctx.log(`{yellow-fg}Model auto-set to ${validModels[0].label}{/yellow-fg}`);
        }
      }, cleanup);
    } else if (index === 2) {
      const available = MODELS.filter(m => m.adapter === ctx.config.agent);
      if (available.length === 0) {
        cleanup();
        ctx.log("{yellow-fg}No model selection for this adapter{/yellow-fg}");
        return;
      }
      const modelProviders = available.map(m => ({
        label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
        value: m.value,
        available: true,
      }));
      showConfigPicker(ctx, overlay, "Select Model", modelProviders, (value) => {
        ctx.config.model = value;
        const team = ctx.orchestrator.getTeam();
        for (const a of team.agents) {
          a.model = value;
        }
        const label = MODELS.find(m => m.value === value)?.label ?? value;
        cleanup();
        ctx.log(`{green-fg}Model changed to ${label}{/green-fg}`);
      }, cleanup);
    }
  });

  configBox.on("cancel", cleanup);
}

/** Show a picker sub-menu inside the config overlay */
export function showConfigPicker(
  ctx: CommandContext,
  parent: blessed.Widgets.BoxElement | blessed.Widgets.Screen,
  title: string,
  options: ProviderOption[],
  onSelect: (value: string) => void,
  onCancel: () => void,
): void {
  const items = options.map(p => {
    if (p.available) return `  {green-fg}●{/green-fg} ${p.label}`;
    return `  {grey-fg}○ ${p.label}{/grey-fg}  {yellow-fg}coming soon{/yellow-fg}`;
  });

  const isStandalone = parent === ctx.screen;
  const pickerOverlay = isStandalone
    ? blessed.box({ parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } })
    : null;
  const renderParent = pickerOverlay ?? parent;

  const picker = blessed.list({
    parent: renderParent,
    top: "center",
    left: "center",
    width: 50,
    height: items.length + 2,
    items,
    tags: true,
    border: { type: "line" },
    label: ` {bold}${title}{/bold} `,
    style: {
      bg: "black",
      border: { fg: "yellow" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  if (pickerOverlay) {
    addHintBar(pickerOverlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");
  }

  picker.select(0);
  picker.focus();
  ctx.scheduleRender();

  const pickerCleanup = () => {
    ctx.screen.removeListener("keypress", kh);
    if (pickerOverlay) {
      pickerOverlay.destroy();
    } else {
      picker.destroy();
    }
    ctx.scheduleRender();
  };

  const doSelect = (index: number) => {
    const opt = options[index];
    if (!opt.available) {
      (picker as any).setLabel(` {yellow-fg}Not available yet{/yellow-fg} `);
      ctx.screen.render();
      setTimeout(() => { (picker as any).setLabel(` {bold}${title}{/bold} `); ctx.screen.render(); }, 1200);
      return;
    }
    pickerCleanup();
    onSelect(opt.value);
  };

  let pickerReady = false;
  setImmediate(() => { pickerReady = true; });
  picker.on("select", (_item: any, index: number) => { if (pickerReady) doSelect(index); });

  const kh = (_ch: string, key: any) => {
    if (!key) return;
    if (key.name === "escape") { pickerCleanup(); onCancel(); return; }
    if (key.name === "up") { picker.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { picker.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") { doSelect((picker as any).selected ?? 0); }
  };
  ctx.screen.on("keypress", kh);
}

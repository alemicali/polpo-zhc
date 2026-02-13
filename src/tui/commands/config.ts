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
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const modelLabel = ctx.config.model
    ? MODELS.find(m => m.value === ctx.config.model)?.label ?? ctx.config.model
    : "default";
  const judgeModelLabel = ctx.config.judgeModel
    ? MODELS.find(m => m.value === ctx.config.judgeModel)?.label ?? ctx.config.judgeModel
    : "default";

  const settings = ctx.orchestrator.getConfig()?.settings;
  const volatileEnabled = settings?.enableVolatileTeams !== false;
  const volatileCleanup = settings?.volatileCleanup ?? "on_complete";
  const taskPrepEnabled = ctx.config.taskPrep !== false;

  const configItems = [
    `  {cyan-fg}Judge{/cyan-fg}            ${getProviderLabel(ctx.config.judge)}`,
    `  {cyan-fg}Judge Model{/cyan-fg}      ${judgeModelLabel}`,
    `  {cyan-fg}Orchestrator{/cyan-fg}     ${getProviderLabel(ctx.config.agent)}`,
    `  {cyan-fg}Agent Model{/cyan-fg}      ${modelLabel}`,
    `  {cyan-fg}Task Preparation{/cyan-fg} ${taskPrepEnabled ? "{green-fg}enabled{/green-fg}" : "{grey-fg}disabled{/grey-fg}"}`,
    `  {cyan-fg}Volatile Teams{/cyan-fg}   ${volatileEnabled ? "{green-fg}enabled{/green-fg}" : "{red-fg}disabled{/red-fg}"}`,
    `  {cyan-fg}Volatile Cleanup{/cyan-fg} ${volatileCleanup === "on_complete" ? "{yellow-fg}on_complete{/yellow-fg}" : "{green-fg}manual{/green-fg}"}`,
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
    label: " {bold}Configuration{/bold} ",
    style: {
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}change{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}");

  configBox.select(0);
  configBox.focus();
  ctx.scheduleRender();

  const doConfigSelect = (index: number) => {
    if (index === 0) {
      // Judge adapter
      showConfigPicker(ctx, overlay, "Select Judge", PROVIDERS, (value) => {
        ctx.config.judge = value;
        // Auto-set judge model if current one is incompatible
        const validModels = MODELS.filter(m => m.adapter === value);
        if (validModels.length > 0 && !validModels.find(m => m.value === ctx.config.judgeModel)) {
          ctx.config.judgeModel = validModels[0].value;
        }
        syncJudgeModel(ctx);
        cleanup();
        ctx.log(`{green-fg}Judge changed to ${getProviderLabel(value)}{/green-fg}`);
      }, cleanup);
    } else if (index === 1) {
      // Judge model
      const available = MODELS.filter(m => m.adapter === ctx.config.judge);
      if (available.length === 0) {
        cleanup();
        ctx.log("{yellow-fg}No model selection for this judge adapter{/yellow-fg}");
        return;
      }
      const modelOptions = available.map(m => ({
        label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
        value: m.value,
        available: true,
      }));
      showConfigPicker(ctx, overlay, "Select Judge Model", modelOptions, (value) => {
        ctx.config.judgeModel = value;
        syncJudgeModel(ctx);
        const label = MODELS.find(m => m.value === value)?.label ?? value;
        cleanup();
        ctx.log(`{green-fg}Judge model changed to ${label}{/green-fg}`);
      }, cleanup);
    } else if (index === 2) {
      // Orchestrator adapter
      showConfigPicker(ctx, overlay, "Select Orchestrator", PROVIDERS, (value) => {
        ctx.config.agent = value;
        const team = ctx.orchestrator.getTeam();
        for (const a of team.agents) {
          a.adapter = value;
        }
        cleanup();
        ctx.log(`{green-fg}Orchestrator changed to ${getProviderLabel(value)}{/green-fg}`);
        const validModels = MODELS.filter(m => m.adapter === value);
        if (validModels.length > 0 && !validModels.find(m => m.value === ctx.config.model)) {
          ctx.config.model = validModels[0].value;
          ctx.log(`{yellow-fg}Agent model auto-set to ${validModels[0].label}{/yellow-fg}`);
        }
      }, cleanup);
    } else if (index === 3) {
      // Agent model
      const available = MODELS.filter(m => m.adapter === ctx.config.agent);
      if (available.length === 0) {
        cleanup();
        ctx.log("{yellow-fg}No model selection for this adapter{/yellow-fg}");
        return;
      }
      const modelOptions = available.map(m => ({
        label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
        value: m.value,
        available: true,
      }));
      showConfigPicker(ctx, overlay, "Select Agent Model", modelOptions, (value) => {
        ctx.config.model = value;
        const team = ctx.orchestrator.getTeam();
        for (const a of team.agents) {
          a.model = value;
        }
        const label = MODELS.find(m => m.value === value)?.label ?? value;
        cleanup();
        ctx.log(`{green-fg}Agent model changed to ${label}{/green-fg}`);
      }, cleanup);
    } else if (index === 4) {
      // Toggle task preparation
      const current = ctx.config.taskPrep !== false;
      ctx.config.taskPrep = !current;
      cleanup();
      ctx.log(`{green-fg}Task preparation ${!current ? "enabled" : "disabled"}{/green-fg}`);
      if (!current) {
        ctx.log("{grey-fg}Tasks will be prepared via LLM before execution{/grey-fg}");
      } else {
        ctx.log("{grey-fg}Tasks will be created directly without LLM preparation{/grey-fg}");
      }
    } else if (index === 5) {
      // Toggle volatile teams
      const cfg = ctx.orchestrator.getConfig();
      if (cfg) {
        const current = cfg.settings.enableVolatileTeams !== false;
        cfg.settings.enableVolatileTeams = !current;
        cleanup();
        ctx.log(`{green-fg}Volatile teams ${!current ? "enabled" : "disabled"}{/green-fg}`);
      }
    } else if (index === 6) {
      // Toggle volatile cleanup policy
      const cfg = ctx.orchestrator.getConfig();
      if (cfg) {
        const current = cfg.settings.volatileCleanup ?? "on_complete";
        cfg.settings.volatileCleanup = current === "on_complete" ? "manual" : "on_complete";
        cleanup();
        ctx.log(`{green-fg}Volatile cleanup: ${cfg.settings.volatileCleanup}{/green-fg}`);
      }
    }
  };

  let cfgReady = false;
  setImmediate(() => { cfgReady = true; });
  configBox.on("select", (_item: any, index: number) => {
    if (cfgReady) doConfigSelect(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { configBox.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { configBox.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (!cfgReady) return;
      doConfigSelect((configBox as any).selected ?? 0);
    }
  });
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

  // Standalone mode: use full createOverlay pattern
  // Nested mode: render inside parent overlay
  let pickerOverlay: blessed.Widgets.BoxElement | null = null;
  let overlayCleanup: (() => void) | null = null;
  let overlayOnKeypress: ((handler: (ch: string, key: any) => void) => void) | null = null;

  if (isStandalone) {
    const ov = createOverlay(ctx);
    pickerOverlay = ov.overlay;
    overlayCleanup = ov.cleanup;
    overlayOnKeypress = ov.onKeypress;
  }
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
    if (overlayCleanup) {
      overlayCleanup();
    } else {
      ctx.screen.removeListener("keypress", kh);
      picker.destroy();
      ctx.scheduleRender();
    }
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

  if (overlayOnKeypress) {
    overlayOnKeypress(kh);
  } else {
    ctx.screen.on("keypress", kh);
  }
}

/** Sync judgeModel from TUI config into orchestrator settings.orchestratorModel */
function syncJudgeModel(ctx: CommandContext): void {
  const cfg = ctx.orchestrator.getConfig();
  if (cfg) {
    cfg.settings.orchestratorModel = ctx.config.judgeModel || undefined;
  }
}

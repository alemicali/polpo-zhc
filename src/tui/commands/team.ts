/**
 * Team management: /team menu, AI generation, add/edit agents, skills, system prompts.
 */

import blessed from "blessed";
import { parse as parseYaml } from "yaml";
import type { CommandContext } from "../context.js";
import { PROVIDERS, MODELS } from "../constants.js";
import { getProviderLabel, formatYamlColored } from "../formatters.js";
import { querySDK as llmQuerySDK, extractTeamYaml as llmExtractTeamYaml } from "../../llm/query.js";
import { buildTeamGenPrompt as buildTeamPrompt } from "../../llm/prompts.js";
import { discoverSkills } from "../../llm/skills.js";
import { createOverlay, addHintBar, showTextInput } from "../widgets.js";
import { showConfigPicker } from "./config.js";

export function cmdTeam(ctx: CommandContext, _args: string[]): void {
  showTeamMenu(ctx);
}

function showTeamMenu(ctx: CommandContext): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);
  const team = ctx.orchestrator.getTeam();

  const buildItems = () => {
    const items: string[] = [];
    const agents = ctx.orchestrator.getAgents();
    // Compute column widths from actual data
    const nameMax = Math.max(6, ...agents.map(a => a.name.length));
    const adapterMax = Math.max(7, ...agents.map(a => a.adapter.length));
    for (const a of agents) {
      const def = a.name === ctx.getDefaultAgent() ? " {green-fg}★{/green-fg}" : "";
      const model = a.model ? ` {grey-fg}(${MODELS.find(m => m.value === a.model)?.label ?? a.model}){/grey-fg}` : "";
      const skillsBadge = a.skills?.length ? ` {yellow-fg}⚡${a.skills.length}{/yellow-fg}` : "";
      const sysPrompt = a.systemPrompt ? " {blue-fg}✎{/blue-fg}" : "";
      items.push(`  {cyan-fg}${a.name.padEnd(nameMax)}{/cyan-fg}  ${a.adapter.padEnd(adapterMax)}  ${a.role || "-"}${model}${skillsBadge}${sysPrompt}${def}`);
    }
    items.push("  {green-fg}+{/green-fg} Add agent");
    items.push("  {magenta-fg}✦{/magenta-fg} Generate team with AI");
    return items;
  };

  const teamList = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: "70%",
    height: 14,
    items: buildItems(),
    tags: true,
    border: { type: "line" },
    label: ` {bold}Team: ${team.name}{/bold} `,
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

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}edit{/grey-fg}  {cyan-fg}d{/cyan-fg} {grey-fg}delete{/grey-fg}  {cyan-fg}r{/cyan-fg} {grey-fg}rename{/grey-fg}  {cyan-fg}*{/cyan-fg} {grey-fg}default{/grey-fg}  {cyan-fg}t{/cyan-fg} {grey-fg}team name{/grey-fg}  {cyan-fg}a{/cyan-fg} {grey-fg}AI generate{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}");

  teamList.select(0);
  ctx.scheduleRender();

  const refreshList = () => {
    teamList.setItems(buildItems());
    ctx.scheduleRender();
  };

  const handleSelect = (idx: number) => {
    const agents = ctx.orchestrator.getAgents();
    const isAIRow = idx === agents.length + 1;
    const isAddRow = idx >= agents.length;
    if (isAIRow) {
      cleanup();
      showAITeamGenerate(ctx);
    } else if (isAddRow) {
      cleanup();
      showAddAgentWizard(ctx);
    } else if (agents[idx]) {
      cleanup();
      showEditAgentMenu(ctx, agents[idx]);
    }
  };

  let ready = false;
  setImmediate(() => { ready = true; });
  teamList.on("select", (_item: any, index: number) => {
    if (!ready) return;
    handleSelect(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (!ready) return;
    const agents = ctx.orchestrator.getAgents();
    const idx = (teamList as any).selected ?? 0;
    const isAddRow = idx >= agents.length;

    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { teamList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { teamList.down(1); ctx.scheduleRender(); return; }

    if (key.name === "return" || key.name === "enter") { handleSelect(idx); return; }

    // d = delete
    if (key.name === "d" && !isAddRow) {
      if (agents.length <= 1) {
        ctx.log("{yellow-fg}Cannot remove the last agent{/yellow-fg}");
        return;
      }
      const agent = agents[idx];
      ctx.orchestrator.removeAgent(agent.name);
      if (agent.name === ctx.getDefaultAgent()) {
        const remaining = ctx.orchestrator.getAgents();
        ctx.setDefaultAgent(remaining[0]?.name ?? "dev");
      }
      ctx.log(`{red-fg}Agent "${agent.name}" removed{/red-fg}`);
      refreshList();
      return;
    }

    // r = rename
    if (key.name === "r" && !isAddRow) {
      const agent = agents[idx];
      cleanup();
      showRenameInput(ctx, agent, agents);
      return;
    }

    // * = set default
    if (_ch === "*" && !isAddRow) {
      ctx.setDefaultAgent(agents[idx].name);
      ctx.log(`{green-fg}Default agent: ${agents[idx].name}{/green-fg}`);
      refreshList();
      return;
    }

    // t = rename team
    if (key.name === "t") {
      cleanup();
      showTextInput(ctx, { title: "Team Name", initial: team.name }).then(name => {
        if (name) {
          ctx.orchestrator.renameTeam(name);
          ctx.log(`{green-fg}Team renamed to "${name}"{/green-fg}`);
        }
        showTeamMenu(ctx);
      });
      return;
    }

    // a = AI generate team
    if (key.name === "a") {
      cleanup();
      showAITeamGenerate(ctx);
      return;
    }
  });
}

function showRenameInput(ctx: CommandContext, agent: any, agents: any[]): void {
  ctx.overlayActive = true;
  const overlay = blessed.box({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: "black" },
  });
  const box = blessed.box({
    parent: overlay, top: "center", left: "center", width: "60%", height: 5,
    border: { type: "line" }, tags: true,
    label: ` {bold}Rename "${agent.name}"{/bold} `,
    style: { bg: "black", fg: "white", border: { fg: "cyan" } },
  });
  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  let buf = agent.name;
  const cursor = "{white-fg}_{/white-fg}";
  box.setContent(` ${buf}${cursor}`);
  ctx.scheduleRender();

  const inputCleanup = () => {
    ctx.overlayActive = false;
    ctx.screen.removeListener("keypress", kh);
    overlay.destroy();
    ctx.scheduleRender();
  };

  const kh = (ch: string, key: any) => {
    if (!key) return;
    if (key.name === "return" || key.name === "enter") {
      const newName = buf.trim();
      inputCleanup();
      if (newName && newName !== agent.name) {
        if (agents.find((a: any) => a.name === newName && a !== agent)) {
          ctx.log(`{red-fg}Agent "${newName}" already exists{/red-fg}`);
        } else {
          const oldName = agent.name;
          agent.name = newName;
          if (ctx.getDefaultAgent() === oldName) ctx.setDefaultAgent(newName);
          ctx.log(`{green-fg}Renamed: ${oldName} → ${newName}{/green-fg}`);
        }
      }
      showTeamMenu(ctx);
      return;
    }
    if (key.name === "escape") { inputCleanup(); showTeamMenu(ctx); return; }
    if (key.name === "backspace") { buf = buf.slice(0, -1); }
    else if (ch && ch.length === 1 && !key.ctrl && !key.meta) { buf += ch; }
    box.setContent(` ${buf}${cursor}`);
    ctx.scheduleRender();
  };
  ctx.screen.on("keypress", kh);
}

// ─── AI Team Generation ────────────────────────────────

function showAITeamGenerate(ctx: CommandContext): void {
  ctx.overlayActive = true;
  const overlay = blessed.box({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: "black" },
  });

  const promptBox = blessed.box({
    parent: overlay, top: "center", left: "center", width: "70%", height: 7,
    border: { type: "line" }, tags: true,
    label: " {magenta-fg}✦{/magenta-fg} {bold}AI Team Generator{/bold} ",
    style: { bg: "black", fg: "white", border: { fg: "magenta" } },
  });

  const hintBox = blessed.box({
    parent: promptBox, top: 0, left: 1, width: "100%-4", height: 1,
    tags: true,
    content: "{grey-fg}Describe the team you need (e.g. \"a fullstack team for a React + Node project\"){/grey-fg}",
    style: { bg: "black" },
  });

  let inputBuffer = "";
  const cursor = "{white-fg}█{/white-fg}";

  const inputLine = blessed.box({
    parent: promptBox, top: 2, left: 1, width: "100%-4", height: 1,
    tags: true, content: ` ${cursor}`, style: { bg: "black" },
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}generate{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");
  ctx.scheduleRender();

  const genCleanup = () => {
    ctx.overlayActive = false;
    ctx.screen.removeListener("keypress", keyHandler);
    overlay.destroy();
    ctx.scheduleRender();
  };

  const keyHandler = (ch: string, key: any) => {
    if (!key) return;

    if (key.name === "escape") {
      genCleanup();
      showTeamMenu(ctx);
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const description = inputBuffer.trim();
      if (!description) return;
      genCleanup();
      generateAITeam(ctx, description);
      return;
    }

    if (key.name === "backspace") {
      inputBuffer = inputBuffer.slice(0, -1);
    } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
      inputBuffer += ch;
    }

    if (inputBuffer.length > 0) { hintBox.hide(); } else { hintBox.show(); }
    inputLine.setContent(` ${inputBuffer}${cursor}`);
    ctx.scheduleRender();
  };

  ctx.screen.on("keypress", keyHandler);
}

async function generateAITeam(ctx: CommandContext, description: string): Promise<void> {
  ctx.logAlways(`{magenta-fg}✦{/magenta-fg} ${description}`);
  ctx.logAlways("");
  ctx.setProcessing(true, "Generating team");

  try {
    const prompt = buildTeamPrompt(ctx.orchestrator, ctx.workDir, description);
    const resultText = await llmQuerySDK(prompt, ["Skill", "Bash"], ctx.workDir, (event) => {
      ctx.setProcessingDetail(event.replace(/\{[^}]*\}/g, "").slice(0, 80));
      ctx.logAlways(`  {grey-fg}${event}{/grey-fg}`);
    });
    ctx.setProcessing(false);

    const yaml = llmExtractTeamYaml(resultText);
    if (!yaml?.trim()) {
      ctx.log("{red-fg}AI returned empty result{/red-fg}");
      return;
    }

    try {
      const doc = parseYaml(yaml);
      if (!doc?.team || !Array.isArray(doc.team) || doc.team.length === 0) {
        ctx.log("{red-fg}Invalid team: no agents found{/red-fg}");
        return;
      }
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      ctx.log(`{red-fg}Invalid YAML: ${msg}{/red-fg}`);
      return;
    }

    showTeamPreview(ctx, yaml, description);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Team generation failed: ${msg}{/red-fg}`);
  }
}

function showTeamPreview(ctx: CommandContext, yaml: string, originalDescription: string): void {
  let doc: any;
  try {
    doc = parseYaml(yaml);
    if (!doc?.team?.length) {
      ctx.log("{red-fg}Invalid team: no agents found{/red-fg}");
      return;
    }
  } catch {
    ctx.log("{red-fg}Invalid YAML in team{/red-fg}");
    return;
  }

  let viewMode: "readable" | "yaml" = "readable";
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const contentBox = blessed.box({
    parent: overlay, top: 0, left: 0, width: "100%", height: "100%-8",
    border: { type: "line" }, tags: true,
    label: " {magenta-fg}✦{/magenta-fg} {bold}Team Preview{/bold} ",
    scrollable: true, keys: true, vi: true, mouse: true,
    style: { bg: "black", border: { fg: "magenta" } },
  });

  const actionItems = [
    "  {green-fg}✓{/green-fg} Apply team",
    "  {yellow-fg}✎{/yellow-fg} Edit YAML",
    "  {cyan-fg}↻{/cyan-fg} Refine with feedback",
  ];
  const actionList = blessed.list({
    parent: overlay, bottom: 1, left: "center", width: 32,
    height: actionItems.length + 2, items: actionItems, tags: true,
    border: { type: "line" },
    style: { bg: "black", border: { fg: "grey" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, vi: false, mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Tab{/cyan-fg} {grey-fg}toggle view{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}actions{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  const formatTeamReadable = (d: any): string => {
    const agents = d.team || [];
    const lines: string[] = [];
    lines.push(`  {bold}${agents.length} agent${agents.length !== 1 ? "s" : ""}{/bold} in team`);
    lines.push("");
    for (const a of agents) {
      const modelLabel = MODELS.find(m => m.value === a.model)?.label ?? a.model ?? "";
      lines.push(`  {cyan-fg}${a.name}{/cyan-fg}  {grey-fg}${a.adapter || "claude-sdk"}{/grey-fg}`);
      if (modelLabel) lines.push(`    {grey-fg}Model: ${modelLabel}{/grey-fg}`);
      if (a.role) lines.push(`    ${a.role}`);
      if (a.systemPrompt) {
        const truncated = String(a.systemPrompt).replace(/\n/g, " ").slice(0, 60);
        lines.push(`    {blue-fg}✎{/blue-fg} ${truncated}${String(a.systemPrompt).length > 60 ? "…" : ""}`);
      }
      if (a.skills?.length) {
        lines.push(`    {yellow-fg}⚡{/yellow-fg} ${a.skills.join(", ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  };

  const renderContent = () => {
    if (viewMode === "readable") {
      contentBox.setContent(formatTeamReadable(doc));
      (contentBox as any).setLabel(" {magenta-fg}✦{/magenta-fg} {bold}Team Preview{/bold} ");
    } else {
      contentBox.setContent(formatYamlColored(yaml));
      (contentBox as any).setLabel(" {magenta-fg}✦{/magenta-fg} {bold}Team (YAML){/bold} ");
    }
  };

  renderContent();
  actionList.select(0);
  ctx.scheduleRender();

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") {
      cleanup();
      ctx.log("{yellow-fg}Team generation cancelled{/yellow-fg}");
      return;
    }
    if (key.full === "tab") {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      renderContent();
      ctx.scheduleRender();
      return;
    }
    if (key.name === "up") { actionList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { actionList.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      const selectedIdx = (actionList as any).selected ?? 0;
      cleanup();
      switch (selectedIdx) {
        case 0: applyTeam(ctx, yaml); break;
        case 1: showTeamYamlEditor(ctx, yaml, originalDescription); break;
        case 2: showTeamRefineInput(ctx, yaml, originalDescription); break;
      }
      return;
    }
  });

  let previewReady = false;
  setImmediate(() => { previewReady = true; });
  actionList.on("select", (_item: any, index: number) => {
    if (!previewReady) return;
    cleanup();
    switch (index) {
      case 0: applyTeam(ctx, yaml); break;
      case 1: showTeamYamlEditor(ctx, yaml, originalDescription); break;
      case 2: showTeamRefineInput(ctx, yaml, originalDescription); break;
    }
  });
}

function applyTeam(ctx: CommandContext, yaml: string): void {
  try {
    const doc = parseYaml(yaml);
    if (!doc?.team || !Array.isArray(doc.team)) {
      ctx.log("{red-fg}Invalid team YAML{/red-fg}");
      return;
    }

    let added = 0;
    let updated = 0;
    for (const agentDef of doc.team) {
      if (!agentDef.name || !agentDef.adapter) continue;
      const existing = ctx.orchestrator.getAgents().find(a => a.name === agentDef.name);
      if (existing) {
        existing.adapter = agentDef.adapter;
        existing.model = agentDef.model;
        existing.role = agentDef.role;
        existing.systemPrompt = agentDef.systemPrompt;
        existing.skills = agentDef.skills;
        updated++;
      } else {
        try {
          ctx.orchestrator.addAgent({
            name: agentDef.name,
            adapter: agentDef.adapter,
            model: agentDef.model,
            role: agentDef.role,
            systemPrompt: agentDef.systemPrompt,
            skills: agentDef.skills,
          });
          added++;
        } catch { /* skip duplicates */ }
      }
    }

    if (!ctx.getDefaultAgent() || !ctx.orchestrator.getAgents().find(a => a.name === ctx.getDefaultAgent())) {
      ctx.setDefaultAgent(ctx.orchestrator.getAgents()[0]?.name ?? "dev");
    }

    ctx.log(`{green-fg}Team applied: ${added} added, ${updated} updated{/green-fg}`);
    ctx.logEvent(`  {magenta-fg}✦{/magenta-fg} Team updated — ${added} added, ${updated} updated`);
    ctx.log("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Failed to apply team: ${msg}{/red-fg}`);
  }
}

function showTeamYamlEditor(ctx: CommandContext, yaml: string, originalDescription: string): void {
  ctx.overlayActive = true;
  const editor = blessed.textarea({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%-1",
    value: yaml, inputOnFocus: false,
    border: { type: "line" }, tags: true,
    label: " {yellow-fg}✎{/yellow-fg} {bold}Edit Team{/bold}  {grey-fg}Ctrl+S save  Escape cancel{/grey-fg} ",
    style: { bg: "black", fg: "white", border: { fg: "yellow" } },
    keys: true, mouse: true, scrollable: true,
  });

  editor.focus();
  editor.readInput(() => {});
  ctx.scheduleRender();

  editor.key(["C-s"], () => {
    const editedYaml = editor.getValue();
    ctx.overlayActive = false;
    editor.destroy();
    showTeamPreview(ctx, editedYaml, originalDescription);
  });

  editor.key(["escape"], () => {
    ctx.overlayActive = false;
    editor.destroy();
    showTeamPreview(ctx, yaml, originalDescription);
  });
}

function showTeamRefineInput(ctx: CommandContext, yaml: string, originalDescription: string): void {
  ctx.overlayActive = true;
  const refineBox = blessed.box({
    parent: ctx.screen, top: "center", left: "center", width: "70%", height: 5,
    border: { type: "line" }, tags: true,
    label: " {cyan-fg}↻{/cyan-fg} {bold}Refine{/bold}  {grey-fg}What should be changed?{/grey-fg} ",
    style: { bg: "black", fg: "white", border: { fg: "cyan" } },
  });

  let refineBuffer = "";
  const cursor = "{white-fg}█{/white-fg}";
  refineBox.setContent(` ${cursor}`);
  ctx.scheduleRender();

  const refineCleanup = () => {
    ctx.overlayActive = false;
    ctx.screen.removeListener("keypress", keyHandler);
    refineBox.destroy();
    ctx.scheduleRender();
  };

  const keyHandler = (ch: string, key: any) => {
    if (!key) return;
    if (key.name === "return" || key.name === "enter") {
      if (refineBuffer.trim()) {
        refineCleanup();
        refineAITeam(ctx, yaml, originalDescription, refineBuffer.trim());
      }
      return;
    }
    if (key.name === "escape") {
      refineCleanup();
      showTeamPreview(ctx, yaml, originalDescription);
      return;
    }
    if (key.name === "backspace") {
      refineBuffer = refineBuffer.slice(0, -1);
    } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
      refineBuffer += ch;
    }
    refineBox.setContent(` ${refineBuffer}${cursor}`);
    ctx.scheduleRender();
  };

  ctx.screen.on("keypress", keyHandler);
}

async function refineAITeam(ctx: CommandContext, currentYaml: string, originalDescription: string, feedback: string): Promise<void> {
  ctx.logAlways(`{cyan-fg}↻{/cyan-fg} Refining: ${feedback}`);
  ctx.logAlways("");
  ctx.setProcessing(true, "Refining team");

  try {
    const prompt = [
      buildTeamPrompt(ctx.orchestrator, ctx.workDir, originalDescription),
      ``,
      `---`,
      ``,
      `Current team YAML:`,
      currentYaml,
      ``,
      `User feedback: "${feedback}"`,
      ``,
      `Revise the team based on the feedback. Output ONLY valid YAML.`,
    ].join("\n");

    const resultText = await llmQuerySDK(prompt, ["Skill", "Bash"], ctx.workDir, (event) => {
      ctx.setProcessingDetail(event.replace(/\{[^}]*\}/g, "").slice(0, 80));
      ctx.logAlways(`  {grey-fg}${event}{/grey-fg}`);
    });
    ctx.setProcessing(false);

    const newYaml = llmExtractTeamYaml(resultText);
    if (!newYaml?.trim()) {
      ctx.log("{red-fg}Refine returned empty result{/red-fg}");
      showTeamPreview(ctx, currentYaml, originalDescription);
      return;
    }

    try {
      const doc = parseYaml(newYaml);
      if (!doc?.team?.length) {
        ctx.log("{red-fg}Refined team has no agents{/red-fg}");
        showTeamPreview(ctx, currentYaml, originalDescription);
        return;
      }
    } catch {
      ctx.log("{red-fg}Refined team has invalid YAML{/red-fg}");
      showTeamPreview(ctx, currentYaml, originalDescription);
      return;
    }

    showTeamPreview(ctx, newYaml, originalDescription);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Refine failed: ${msg}{/red-fg}`);
  }
}

// ─── Add Agent Wizard ────────────────────────────────────

function showAddAgentWizard(ctx: CommandContext): void {
  ctx.overlayActive = true;
  const overlay = blessed.box({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: "black" },
  });

  let step = 0;
  let agentName = "";
  let agentAdapter = ctx.config.agent;
  let agentModel = ctx.config.model;
  let agentRole = "";

  const stepLabel = blessed.box({
    parent: overlay, top: 3, left: "center", width: "60%", height: 1,
    content: "", tags: true, style: { bg: "black" },
  });

  const inputBox = blessed.box({
    parent: overlay, top: 5, left: "center", width: "60%", height: 3,
    border: { type: "line" }, tags: true,
    style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    hidden: true,
  });

  const selList = blessed.list({
    parent: overlay, top: 5, left: "center", width: "60%", height: 8,
    items: [], tags: true, border: { type: "line" },
    style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, vi: false, mouse: true, hidden: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}navigate{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  let inputBuf = "";
  const cursor = "{white-fg}█{/white-fg}";
  let listData: string[] = [];
  let stepReady = false;
  setImmediate(() => { stepReady = true; });

  const wizCleanup = () => {
    ctx.screen.removeListener("keypress", keyHandler);
    ctx.overlayActive = false;
    overlay.destroy();
    showTeamMenu(ctx);
  };

  const showTextStep = (label: string) => {
    stepLabel.setContent(label);
    selList.hide();
    inputBox.show();
    inputBuf = "";
    inputBox.setContent(` ${cursor}`);
    stepReady = false;
    setImmediate(() => { stepReady = true; });
    ctx.scheduleRender();
  };

  const showListStep = (label: string, items: string[], values: string[]) => {
    stepLabel.setContent(label);
    inputBox.hide();
    listData = values;
    selList.setItems(items);
    selList.height = items.length + 2;
    selList.show();
    selList.select(0);
    stepReady = false;
    setImmediate(() => { stepReady = true; });
    ctx.scheduleRender();
  };

  const finishAdd = () => {
    if (!agentName.trim()) {
      ctx.log("{red-fg}Agent name required{/red-fg}");
      wizCleanup();
      return;
    }
    try {
      ctx.orchestrator.addAgent({
        name: agentName.trim(),
        adapter: agentAdapter,
        model: agentModel || undefined,
        role: agentRole || undefined,
      });
      ctx.log(`{green-fg}Agent "${agentName.trim()}" added (${agentAdapter}){/green-fg}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`{red-fg}${msg}{/red-fg}`);
    }
    wizCleanup();
  };

  const goToAdapterStep = () => {
    const available = PROVIDERS.filter(p => p.available);
    step = 1;
    showListStep(
      "{bold}Step 2/4 — Adapter{/bold}",
      available.map(p => `  {green-fg}●{/green-fg} ${p.label}`),
      available.map(p => p.value),
    );
  };

  const goToModelStep = () => {
    const models = MODELS.filter(m => m.adapter === agentAdapter);
    if (models.length > 0) {
      step = 2;
      showListStep(
        "{bold}Step 3/4 — Model{/bold}",
        models.map(m => `  {green-fg}●{/green-fg} ${m.label} {grey-fg}${m.value}{/grey-fg}`),
        models.map(m => m.value),
      );
    } else {
      agentModel = "";
      goToRoleStep();
    }
  };

  const goToRoleStep = () => {
    step = 3;
    showTextStep("{bold}Step 4/4 — Role{/bold} {grey-fg}(optional, Enter to skip){/grey-fg}");
  };

  showTextStep("{bold}Step 1/4 — Agent name{/bold}");

  const keyHandler = (ch: string, key: any) => {
    if (!key) return;
    if (key.name === "escape") { wizCleanup(); return; }

    const isTextStep = step === 0 || step === 3;
    const isListStep = step === 1 || step === 2;

    if (isTextStep) {
      if (key.name === "return" || key.name === "enter") {
        if (!stepReady) return;
        if (step === 0) {
          agentName = inputBuf;
          if (!agentName.trim()) return;
          goToAdapterStep();
        } else {
          agentRole = inputBuf;
          finishAdd();
        }
        return;
      }
      if (key.name === "backspace") {
        inputBuf = inputBuf.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        inputBuf += ch;
      }
      inputBox.setContent(` ${inputBuf}${cursor}`);
      ctx.scheduleRender();
      return;
    }

    if (isListStep) {
      if (key.name === "up") { selList.up(1); ctx.scheduleRender(); return; }
      if (key.name === "down") { selList.down(1); ctx.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") {
        if (!stepReady) return;
        const index = (selList as any).selected ?? 0;
        const value = listData[index];
        if (step === 1) {
          agentAdapter = value ?? ctx.config.agent;
          goToModelStep();
        } else if (step === 2) {
          agentModel = value ?? "";
          goToRoleStep();
        }
        return;
      }
    }
  };

  ctx.screen.on("keypress", keyHandler);
}

// ─── Edit Agent Menu ─────────────────────────────────────

function showEditAgentMenu(ctx: CommandContext, agent: { name: string; adapter: string; model?: string; role?: string; systemPrompt?: string; skills?: string[] }): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const modelLabel = agent.model
    ? MODELS.find(m => m.value === agent.model)?.label ?? agent.model
    : "default";

  const truncPrompt = agent.systemPrompt
    ? agent.systemPrompt.replace(/\n/g, " ").slice(0, 60) + (agent.systemPrompt.length > 60 ? "…" : "")
    : "-";

  const skillsLabel = agent.skills?.length ? agent.skills.join(", ") : "-";

  const items = [
    `  {cyan-fg}Adapter{/cyan-fg}       ${getProviderLabel(agent.adapter)}`,
    `  {cyan-fg}Model{/cyan-fg}         ${modelLabel}`,
    `  {cyan-fg}Role{/cyan-fg}          ${agent.role || "-"}`,
    `  {cyan-fg}System Prompt{/cyan-fg} ${truncPrompt}`,
    `  {cyan-fg}Skills{/cyan-fg}        ${skillsLabel}`,
  ];

  const editList = blessed.list({
    parent: overlay, top: "center", left: "center", width: "60%",
    height: items.length + 2, items, tags: true,
    border: { type: "line" },
    label: ` {bold}Edit: ${agent.name}{/bold} `,
    style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, vi: false, mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}change{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}");

  editList.select(0);
  ctx.scheduleRender();

  const handleEditSelect = (index: number) => {
    if (index === 0) {
      cleanup();
      showConfigPicker(ctx, ctx.screen as any, "Select Adapter", PROVIDERS, (value) => {
        const agents = ctx.orchestrator.getAgents();
        const found = agents.find(a => a.name === agent.name);
        if (found) {
          found.adapter = value;
          const validModels = MODELS.filter(m => m.adapter === value);
          if (validModels.length > 0 && !validModels.find(m => m.value === found.model)) {
            found.model = validModels[0].value;
          }
        }
        ctx.log(`{green-fg}${agent.name}: adapter → ${getProviderLabel(value)}{/green-fg}`);
        showTeamMenu(ctx);
      }, () => showTeamMenu(ctx));
    } else if (index === 1) {
      const available = MODELS.filter(m => m.adapter === agent.adapter);
      if (available.length === 0) {
        ctx.log("{yellow-fg}No models for this adapter{/yellow-fg}");
        return;
      }
      const modelOpts = available.map(m => ({
        label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
        value: m.value,
        available: true,
      }));
      cleanup();
      showConfigPicker(ctx, ctx.screen as any, "Select Model", modelOpts, (value) => {
        const agents = ctx.orchestrator.getAgents();
        const found = agents.find(a => a.name === agent.name);
        if (found) found.model = value;
        const label = MODELS.find(m => m.value === value)?.label ?? value;
        ctx.log(`{green-fg}${agent.name}: model → ${label}{/green-fg}`);
        showTeamMenu(ctx);
      }, () => showTeamMenu(ctx));
    } else if (index === 2) {
      cleanup();
      showRoleInput(ctx, agent);
    } else if (index === 3) {
      cleanup();
      showSystemPromptEditor(ctx, agent);
    } else if (index === 4) {
      cleanup();
      showSkillPicker(ctx, agent);
    }
  };

  let ready = false;
  setImmediate(() => { ready = true; });
  editList.on("select", (_item: any, index: number) => {
    if (!ready) return;
    handleEditSelect(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (!ready) return;
    if (key.name === "escape") { cleanup(); showTeamMenu(ctx); return; }
    if (key.name === "up") { editList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { editList.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      handleEditSelect((editList as any).selected ?? 0);
      return;
    }
  });
}

function showRoleInput(ctx: CommandContext, agent: { name: string; role?: string }): void {
  ctx.overlayActive = true;
  const overlay = blessed.box({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: "black" },
  });
  const box = blessed.box({
    parent: overlay, top: "center", left: "center", width: "60%", height: 5,
    border: { type: "line" }, tags: true,
    label: ` {bold}Enter role{/bold} `,
    style: { bg: "black", fg: "white", border: { fg: "cyan" } },
  });
  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  let buf = agent.role || "";
  const cursor = "{white-fg}_{/white-fg}";
  box.setContent(` ${buf}${cursor}`);
  ctx.scheduleRender();

  const inputCleanup = () => {
    ctx.overlayActive = false;
    ctx.screen.removeListener("keypress", kh);
    overlay.destroy();
    ctx.scheduleRender();
  };

  const kh = (ch: string, key: any) => {
    if (!key) return;
    if (key.name === "return" || key.name === "enter") {
      const value = buf.trim();
      inputCleanup();
      const agents = ctx.orchestrator.getAgents();
      const found = agents.find(a => a.name === agent.name);
      if (found) found.role = value || undefined;
      ctx.log(`{green-fg}${agent.name}: role → ${value || "-"}{/green-fg}`);
      showTeamMenu(ctx);
      return;
    }
    if (key.name === "escape") { inputCleanup(); showTeamMenu(ctx); return; }
    if (key.name === "backspace") { buf = buf.slice(0, -1); }
    else if (ch && ch.length === 1 && !key.ctrl && !key.meta) { buf += ch; }
    box.setContent(` ${buf}${cursor}`);
    ctx.scheduleRender();
  };
  ctx.screen.on("keypress", kh);
}

function showSystemPromptEditor(ctx: CommandContext, agent: { name: string; systemPrompt?: string }): void {
  ctx.overlayActive = true;
  const overlay = blessed.box({
    parent: ctx.screen, top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: "black" },
  });
  const editor = blessed.textarea({
    parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
    value: agent.systemPrompt || "", inputOnFocus: false,
    border: { type: "line" }, tags: true,
    label: ` {blue-fg}✎{/blue-fg} {bold}System Prompt: ${agent.name}{/bold} `,
    style: { bg: "black", fg: "white", border: { fg: "blue" } },
    keys: true, mouse: true, scrollable: true,
  });
  addHintBar(overlay, " {cyan-fg}Ctrl+S{/cyan-fg} {grey-fg}save{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  editor.focus();
  editor.readInput(() => {});
  ctx.scheduleRender();

  const edCleanup = () => {
    ctx.overlayActive = false;
    overlay.destroy();
    ctx.scheduleRender();
  };

  editor.key(["C-s"], () => {
    const value = editor.getValue().trim();
    edCleanup();
    const agents = ctx.orchestrator.getAgents();
    const found = agents.find(a => a.name === agent.name);
    if (found) found.systemPrompt = value || undefined;
    ctx.logAlways(`{green-fg}${agent.name}: system prompt ${value ? "updated" : "cleared"}{/green-fg}`);
    showTeamMenu(ctx);
  });

  editor.key(["escape"], () => {
    edCleanup();
    showTeamMenu(ctx);
  });
}

function showSkillPicker(ctx: CommandContext, agent: { name: string; skills?: string[] }): void {
  const available = discoverSkills(ctx.workDir);
  const currentSkills = new Set(agent.skills ?? []);
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const buildSkillItems = () =>
    available.map(s => {
      const check = currentSkills.has(s.name) ? "{green-fg}✓{/green-fg}" : " ";
      const descMax = Math.max(20, ((ctx.screen.cols as number) || 80) - s.name.length - 12);
      return `  [${check}] {cyan-fg}${s.name}{/cyan-fg}  {grey-fg}${s.description.slice(0, descMax)}{/grey-fg}`;
    });

  const items = available.length > 0
    ? buildSkillItems()
    : ["  {grey-fg}No skills found in .claude/skills/{/grey-fg}"];

  const skillList = blessed.list({
    parent: overlay, top: "center", left: "center", width: 60,
    height: Math.min(available.length + 4, 16), items, tags: true,
    border: { type: "line" },
    label: ` {yellow-fg}⚡{/yellow-fg} {bold}Skills: ${agent.name}{/bold} `,
    style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, vi: false, mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Space{/cyan-fg} {grey-fg}toggle{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}save{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  skillList.select(0);
  ctx.scheduleRender();

  const refreshItems = () => {
    skillList.setItems(buildSkillItems());
    ctx.scheduleRender();
  };

  const toggleSkill = (idx: number) => {
    if (idx < 0 || idx >= available.length) return;
    const name = available[idx].name;
    if (currentSkills.has(name)) { currentSkills.delete(name); }
    else { currentSkills.add(name); }
    refreshItems();
  };

  let skillReady = false;
  setImmediate(() => { skillReady = true; });
  skillList.on("select", (_item: any, index: number) => {
    if (!skillReady) return;
    toggleSkill(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); showTeamMenu(ctx); return; }
    if (key.name === "up") { skillList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { skillList.down(1); ctx.scheduleRender(); return; }
    if (key.name === "space") {
      const idx = (skillList as any).selected ?? 0;
      toggleSkill(idx);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      cleanup();
      const agents = ctx.orchestrator.getAgents();
      const found = agents.find(a => a.name === agent.name);
      if (found) {
        found.skills = currentSkills.size > 0 ? [...currentSkills] : undefined;
      }
      ctx.log(`{green-fg}${agent.name}: skills → ${currentSkills.size > 0 ? [...currentSkills].join(", ") : "none"}{/green-fg}`);
      showTeamMenu(ctx);
      return;
    }
  });
}

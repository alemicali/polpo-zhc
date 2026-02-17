/**
 * Mention parsing — extracts @agent, #task, %plan from input text.
 * Returns parsed mentions and the clean text (mentions removed).
 *
 * Port of src/tui/mentions.ts for the pi-tui TUI2.
 */

export interface ParsedMentions {
  /** Agent name from @name mention */
  agent?: string;
  /** Task title from #title mention */
  taskRef?: string;
  /** Plan group from %group mention */
  planRef?: string;
  /** Input text with mentions stripped */
  text: string;
}

/**
 * Parse mentions from raw input.
 * Supports: @agent-name, #"task title with spaces", %plan-group
 * Quoted form: @"agent name", #"task title", %"plan group"
 */
export function parseMentions(input: string): ParsedMentions {
  let text = input;
  let agent: string | undefined;
  let taskRef: string | undefined;
  let planRef: string | undefined;

  // @agent — quoted or unquoted
  const agentQuoted = text.match(/@"([^"]+)"/);
  if (agentQuoted) {
    agent = agentQuoted[1];
    text = text.replace(agentQuoted[0], "").trim();
  } else {
    const agentMatch = text.match(/@([\w-]+)/);
    if (agentMatch) {
      agent = agentMatch[1];
      text = text.replace(agentMatch[0], "").trim();
    }
  }

  // #task — quoted or unquoted
  const taskQuoted = text.match(/#"([^"]+)"/);
  if (taskQuoted) {
    taskRef = taskQuoted[1];
    text = text.replace(taskQuoted[0], "").trim();
  } else {
    const taskMatch = text.match(/#([\w-]+)/);
    if (taskMatch) {
      taskRef = taskMatch[1];
      text = text.replace(taskMatch[0], "").trim();
    }
  }

  // %plan — quoted or unquoted
  const planQuoted = text.match(/%"([^"]+)"/);
  if (planQuoted) {
    planRef = planQuoted[1];
    text = text.replace(planQuoted[0], "").trim();
  } else {
    const planMatch = text.match(/%([\w-]+)/);
    if (planMatch) {
      planRef = planMatch[1];
      text = text.replace(planMatch[0], "").trim();
    }
  }

  return { agent, taskRef, planRef, text: text.trim() };
}

/**
 * Find mention segments in text for syntax highlighting.
 * Returns array of { start, end, type } for each mention found.
 */
export interface MentionSpan {
  start: number;
  end: number;
  type: "agent" | "task" | "plan";
}

export function findMentionSpans(input: string): MentionSpan[] {
  const spans: MentionSpan[] = [];

  // @agent
  for (const m of input.matchAll(/@"[^"]+"|@[\w-]+/g)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, type: "agent" });
  }

  // #task
  for (const m of input.matchAll(/#"[^"]+"|#[\w-]+/g)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, type: "task" });
  }

  // %plan
  for (const m of input.matchAll(/%"[^"]+"|%[\w-]+/g)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, type: "plan" });
  }

  return spans.sort((a, b) => a.start - b.start);
}

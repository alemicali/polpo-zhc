import { describe, expect, it } from "vitest";
import { AGENT_TOOL_GROUPS, ProgressiveToolSet, type ToolSearchResult } from "@polpo-ai/core/progressive-tools";
import {
  GITHUB_SPECS, GMAIL_SPECS, LINEAR_SPECS, SLACK_SPECS, githubTools, gmailTools, linearTools, slackTools,
} from "./fixtures/connector-tools.js";

const plain = (name: string, description: string) => ({ name, description, parameters: { type: "object", properties: {} } });

const CONNECTOR_NAMES = { linear: "Linear", gmail: "Gmail", "gmail-2": "Gmail 2 – info@lumea.dev", github: "GitHub", slack: "Slack" };
const CONNECTOR_APPS = { linear: "linear", gmail: "gmail", "gmail-2": "gmail", github: "github", slack: "slack" };

function allTools() {
  return [
    plain("read", "Read a file."), plain("bash", "Run a shell command."),
    ...linearTools(), ...gmailTools(), ...gmailTools("gmail-2", CONNECTOR_NAMES["gmail-2"]), ...githubTools(), ...slackTools(),
    plain("pdf_create", "Create a PDF document from text."), plain("excel_read", "Read an Excel spreadsheet."),
    plain("browser_click", "Click an element in the browser page."), plain("browser_navigate", "Open a URL in the browser."),
  ];
}

function makeSet(extra: Partial<ConstructorParameters<typeof ProgressiveToolSet>[0]> = {}) {
  return new ProgressiveToolSet({
    tools: allTools(), groups: AGENT_TOOL_GROUPS, mode: "always", connectorNames: CONNECTOR_NAMES, connectorApps: CONNECTOR_APPS, ...extra,
  });
}

const names = (result: ToolSearchResult) => result.hits.map((hit) => hit.name);
const DEFERRED = 78 + 23 + 23 + 46 + 27 + 4;

describe("fixtures", () => {
  it("are the size of the real servers", () => {
    expect([LINEAR_SPECS.length, GMAIL_SPECS.length, GITHUB_SPECS.length, SLACK_SPECS.length]).toEqual([78, 23, 46, 27]);
    expect(makeSet().groups().reduce((sum, group) => sum + group.tools.length, 0)).toBe(DEFERRED);
  });
});

describe("filters", () => {
  const set = makeSet();

  it("keeps only the connectors asked for (hard filter, not a boost)", () => {
    const result = set.find({ query: "send", connectors: ["gmail-2"] });
    expect(names(result)[0]).toBe("mcp__gmail-2__send_message");
    expect(result.hits.every((hit) => hit.groupId === "mcp__gmail-2")).toBe(true);
    expect(result.scope).toEqual(["mcp__gmail-2"]);
    expect(result.notes).toEqual([]);
    // a strong match elsewhere stays out
    expect(names(set.find({ query: "post message", connectors: ["gmail"] })).some((n) => n.startsWith("mcp__slack__"))).toBe(false);
  });

  it("resolves an app (catalog id) to all its accounts, with a note", () => {
    const result = set.find({ query: "send email", connectors: ["gmail"] });
    expect(new Set(result.hits.map((hit) => hit.groupId))).toEqual(new Set(["mcp__gmail", "mcp__gmail-2"]));
    expect(result.notes[0]).toContain('connectors: "gmail" → Gmail [connector gmail], Gmail 2 – info@lumea.dev [connector gmail-2]');
    expect(result.notes[0]).toContain('"mcp__gmail"');
    // mcp__<id> is that one account
    expect(set.find({ query: "send", connectors: ["mcp__gmail"] }).scope).toEqual(["mcp__gmail"]);
    expect(set.find({ query: "send", connectors: ["mcp__gmail__*"] }).scope).toEqual(["mcp__gmail"]);
  });

  it("resolves an app from the account id when the catalog id is unknown", () => {
    const noApps = makeSet({ connectorApps: undefined });
    expect(noApps.find({ query: "send", connectors: ["gmail"] }).scope.sort()).toEqual(["mcp__gmail", "mcp__gmail-2"]);
  });

  it("takes an account's display name or the start of it", () => {
    expect(set.find({ query: "send", connectors: ["Gmail 2 – info@lumea.dev"] }).scope).toEqual(["mcp__gmail-2"]);
    expect(set.find({ query: "send", connectors: ["info@lumea.dev"] }).scope).toEqual(["mcp__gmail-2"]);
    expect(set.find({ query: "issue", connectors: ["GitHub"] }).scope).toEqual(["mcp__github"]);
  });

  it("filters by group, and accepts a group given as a connector (with a note)", () => {
    expect(names(set.find({ query: "click", groups: ["browser"] }))).toEqual(["browser_click"]);
    const crossed = set.find({ query: "pdf", connectors: ["documents"] });
    expect(names(crossed)[0]).toBe("pdf_create");
    expect(crossed.notes[0]).toContain('connectors: "documents" → Excel, PDF and Word files [group documents]');
    // connectors and groups together: the union
    const both = set.find({ list: true, connectors: ["slack"], groups: ["browser"] });
    expect(both.total).toBe(27 + 2);
  });

  it("reports unknown filter values with the valid ones instead of an empty answer", () => {
    const result = set.find({ query: "send", connectors: ["outlook"] });
    expect(result.hits).toEqual([]);
    expect(result.notes[0]).toContain('Unknown connector "outlook"');
    expect(result.notes[0]).toContain("gmail-2 (Gmail 2 – info@lumea.dev)");
    expect(result.notes[0]).toContain("groups: browser, documents");
    const text = set.run("tools_search", { query: "send", connectors: ["outlook"] });
    expect(text).toContain("Note: Unknown connector");
    expect(text).toContain("Nothing searched");
    // one known, one unknown: the known one is searched, the unknown one noted
    const mixed = set.find({ query: "send", connectors: ["slack", "teams"] });
    expect(names(mixed).every((n) => n.startsWith("mcp__slack__"))).toBe(true);
    expect(mixed.hits.length).toBeGreaterThan(0);
    expect(mixed.notes.join(" ")).toContain('Unknown connector "teams"');
  });

  it("only sees the tools the run was given (scoping stays enforced)", () => {
    const scoped = new ProgressiveToolSet({
      tools: [plain("read", "Read."), ...linearTools()], mode: "always", connectorNames: { linear: "Linear" },
    });
    expect(scoped.find({ query: "send email" }).hits).toEqual([]);
    expect(scoped.find({ query: "send", connectors: ["gmail"] }).notes[0]).toContain('Unknown connector "gmail"');
    expect(scoped.load(["gmail", "mcp__gmail__send_message"]).unknown).toEqual(["gmail", "mcp__gmail__send_message"]);
  });
});

describe("ranking", () => {
  const set = makeSet();
  const top = (query: string, filters: { connectors?: string[] } = {}) => names(set.find({ query, ...filters }));

  it.each([
    ["create a linear issue", "mcp__linear__save_issue"],
    ["list linear issues", "mcp__linear__list_issues"],
    ["add a comment to a linear issue", "mcp__linear__save_comment"],
    ["linear cycles", "mcp__linear__list_cycles"],
    ["open a pull request", "mcp__github__create_pull_request"],
    ["merge pr", "mcp__github__merge_pull_request"],
    ["github issue comment", "mcp__github__add_issue_comment"],
    ["search code", "mcp__github__search_code"],
    ["workflow logs", "mcp__github__get_job_logs"],
    ["post message to slack channel", "mcp__slack__post_message"],
    ["slack reply thread", "mcp__slack__reply_to_thread"],
    ["find slack user by email", "mcp__slack__lookup_user_by_email"],
    ["delete comment", "mcp__linear__delete_comment"],
    ["mcp__gmail__search_threads", "mcp__gmail__search_threads"],
    ["search_threads", "mcp__gmail-2__search_threads"],
    ["pdf", "pdf_create"],
  ])("%s → %s first", (query, expected) => {
    const hits = top(query);
    // two accounts of one app tie: either account's tool is right
    expect(hits[0].replace("mcp__gmail-2__", "mcp__gmail__")).toBe(expected.replace("mcp__gmail-2__", "mcp__gmail__"));
  });

  it("finds a tool with the synonyms tool names use", () => {
    expect(top("send email", { connectors: ["mcp__gmail"] })[0]).toBe("mcp__gmail__send_message");
    expect(top("remove label from thread", { connectors: ["mcp__gmail"] })[0]).toBe("mcp__gmail__unlabel_thread");
    expect(top("trash message", { connectors: ["mcp__gmail"] })[0]).toBe("mcp__gmail__trash_message");
    expect(top("edit message", { connectors: ["slack"] })[0]).toBe("mcp__slack__update_message");
    expect(top("add a reaction", { connectors: ["slack"] })[0]).toBe("mcp__slack__add_reaction");
    expect(top("fetch thread", { connectors: ["mcp__gmail"] })[0]).toBe("mcp__gmail__get_thread");
  });

  it("handles plural, singular, camelCase and kebab-case", () => {
    expect(top("pull requests")).toContain("mcp__github__list_pull_requests");
    expect(top("issue labels")[0]).toBe("mcp__linear__list_issue_labels");
    expect(top("listIssues")).toContain("mcp__linear__list_issues");
    expect(top("list-branches")[0]).toBe("mcp__github__list_branches");
  });

  it("puts the named app first and leaves noise out", () => {
    const linear = set.find({ query: "create a linear issue" });
    expect(linear.hits.every((hit) => hit.groupId === "mcp__linear")).toBe(true);
    // without the app name both trackers come up
    const both = new Set(set.find({ query: "create issue" }).hits.map((hit) => hit.groupId));
    expect(both).toEqual(new Set(["mcp__linear", "mcp__github"]));
    // a narrow query stays narrow
    expect(set.find({ query: "merge pr" }).total).toBeLessThanOrEqual(3);
  });

  it("orders the same way every time (stable on ties)", () => {
    const first = set.find({ query: "list" });
    for (let i = 0; i < 3; i += 1) expect(names(makeSet().find({ query: "list" }))).toEqual(names(first));
  });

  it("understands Italian requests", () => {
    expect(top("invia una email", { connectors: ["mcp__gmail"] })[0]).toBe("mcp__gmail__send_message");
    expect(top("cerca le issue su github")[0]).toBe("mcp__github__search_issues");
    expect(top("elenca i progetti")[0]).toBe("mcp__linear__list_projects");
    expect(top("crea una pull request")[0]).toBe("mcp__github__create_pull_request");
    expect(top("elimina il commento")[0]).toBe("mcp__linear__delete_comment");
    expect(top("aggiorna messaggio slack")[0]).toBe("mcp__slack__update_message");
  });

  it("tolerates a typo in a long word", () => {
    expect(top("mesage", { connectors: ["slack"] })).toContain("mcp__slack__post_message");
  });
});

describe("limit, total, paging", () => {
  const set = makeSet();

  it("shows the top N with the total and how to page", () => {
    const result = set.find({ query: "linear" });
    expect(result.hits).toHaveLength(8);
    expect(result.total).toBe(78);
    expect(result.more).toBe(true);
    expect(result.nextOffset).toBe(8);
    const text = set.formatSearch(result);
    expect(text).toMatch(/^78 matches for "linear" \(showing 1–8; next page: offset 8\); load with tools_load:/);
    // limit and offset
    const page = set.find({ query: "linear", limit: 5, offset: 75 });
    expect(page.hits).toHaveLength(3);
    expect(page.more).toBe(false);
    expect(page.nextOffset).toBeUndefined();
    expect(set.find({ query: "linear", limit: 500 }).limit).toBe(25);
  });

  it("reaches every match by paging, once each", () => {
    const seen: string[] = [];
    let offset = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = set.find({ query: "issue", limit: 4, offset });
      seen.push(...names(result));
      if (!result.more) break;
      offset = result.nextOffset!;
    }
    const total = set.find({ query: "issue" }).total;
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("does not cut a tie of strong matches at the page edge", () => {
    const tied = Array.from({ length: 11 }, (_, i) => plain(`mcp__acme__widget_x${String.fromCharCode(97 + i)}`, "Widget operation."));
    const tieSet = new ProgressiveToolSet({ tools: tied, mode: "always" });
    const result = tieSet.find({ query: "widget", limit: 8 });
    // all 11 tie and the tie ends soon after the edge: shown together
    expect(result.hits).toHaveLength(11);
    expect(result.more).toBe(false);
    // a tie that runs on (a whole connector): plain paging
    const many = new ProgressiveToolSet({ tools: Array.from({ length: 30 }, (_, i) => plain(`mcp__acme__widget_${i}`, "Widget operation.")), mode: "always" });
    const first = many.find({ query: "widget", limit: 8 });
    expect(first.hits).toHaveLength(8);
    expect(first.nextOffset).toBe(8);
  });

  it("marks loaded tools", () => {
    const local = makeSet();
    local.load(["mcp__slack__post_message"]);
    const hit = local.find({ query: "post message", connectors: ["slack"] }).hits.find((h) => h.name === "mcp__slack__post_message")!;
    expect(hit.loaded).toBe(true);
    expect(local.run("tools_search", { query: "post message", connectors: ["slack"] })).toContain("- mcp__slack__post_message (loaded) — ");
  });
});

describe("list and summary", () => {
  const set = makeSet();

  it("lists every tool of a connector, compact and paged", () => {
    const first = set.find({ list: true, connectors: ["linear"] });
    expect(first.mode).toBe("list");
    expect(first.hits).toHaveLength(50);
    expect(first.total).toBe(78);
    expect(first.more).toBe(true);
    const second = set.find({ list: true, connectors: ["linear"], offset: first.nextOffset });
    expect(second.hits).toHaveLength(28);
    expect(new Set([...names(first), ...names(second)])).toEqual(new Set(linearTools().map((t) => t.name)));
    const text = set.formatSearch(first);
    expect(text).toMatch(/^78 tools to load \(showing 1–50; next page: offset 50\)/);
    expect(text).toContain("Linear [connector linear] — 78 tools:");
    expect(text).toContain("- mcp__linear__create_attachment — Attach a link or file to an issue.");
  });

  it("lists with an empty query or * and a filter", () => {
    expect(set.find({ query: "", connectors: ["slack"] }).total).toBe(27);
    expect(set.find({ query: "*", groups: ["browser"] }).hits.map((h) => h.name)).toEqual(["browser_click", "browser_navigate"]);
  });

  it("reaches every loadable tool with list: true and no filter", () => {
    const seen = new Set<string>();
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = set.find({ list: true, offset, limit: 100 });
      for (const hit of page.hits) seen.add(hit.name);
      offset = page.nextOffset;
    }
    expect(seen.size).toBe(DEFERRED);
    expect(seen.has("read")).toBe(false);
  });

  it("summarises connectors and groups when there is no query and no filter", () => {
    const result = set.find({});
    expect(result.mode).toBe("summary");
    expect(result.hits).toEqual([]);
    expect(result.counts.map((c) => [c.filter, c.tools])).toEqual([
      ["github", 46], ["gmail", 23], ["gmail-2", 23], ["linear", 78], ["slack", 27], ["browser", 2], ["documents", 2],
    ]);
    const text = set.run("tools_search", {});
    expect(text).toContain(`Tools you can load (${DEFERRED})`);
    expect(text).toContain("- Gmail 2 – info@lumea.dev [connector gmail-2]: 23 tools");
  });

  it("groups search hits by connector account, with counts", () => {
    const text = set.run("tools_search", { query: "send email" });
    expect(text).toContain("Gmail [connector gmail] — 1 match:");
    expect(text).toContain("Gmail 2 – info@lumea.dev [connector gmail-2] — 1 match:");
    expect(text).toContain("- mcp__gmail-2__send_message — Send an email message");
    // the connector tag is not repeated in every line
    expect(text).not.toContain("[Gmail]");
  });

  it("gives structured details to UIs", async () => {
    const search = set.metaTools.find((t) => t.name === "tools_search")!;
    const out = await search.execute("call-1", { query: "linear", limit: 3 });
    expect(out.details).toMatchObject({ mode: "search", total: 78, more: true, nextOffset: 3 });
    expect((out.details as ToolSearchResult).hits).toHaveLength(3);
    expect((out.details as ToolSearchResult).counts).toEqual([expect.objectContaining({ id: "mcp__linear", filter: "linear", matches: 78, tools: 78 })]);
  });
});

describe("tools_load by connector, account, app and group", () => {
  it("loads a whole connector by id, prefix, account name or app", () => {
    const set = makeSet();
    expect(set.loadDetailed(["mcp__gmail-2__*"]).loaded).toHaveLength(23);
    expect(set.loadDetailed(["Slack"]).loaded).toHaveLength(27);
    const byApp = makeSet().loadDetailed(["gmail"]);
    expect(byApp.loaded).toHaveLength(46);
    expect(byApp.groups.map((g) => g.id)).toEqual(["mcp__gmail", "mcp__gmail-2"]);
    expect(byApp.notes[0]).toContain('names: "gmail" →');
    const one = makeSet().run("tools_load", { names: ["mcp__gmail"] });
    expect(one).toMatch(/^Loaded 23 tools \(all of Gmail \[gmail\]\)/);
  });

  it("loads a group, reports what was already there and suggests close names for unknown ones", () => {
    const set = makeSet();
    const text = set.run("tools_load", { names: ["documents", "read", "mcp__gmail__send_mesage", "zzz"] });
    expect(text).toContain("Loaded 2 tools (all of Excel, PDF and Word files [documents])");
    expect(text).toContain("Already available: read.");
    expect(text).toContain("mcp__gmail__send_mesage (did you mean mcp__gmail__send_message");
    expect(text).toContain("zzz");
    expect(set.takeNewlyLoaded().map((t) => t.name).sort()).toEqual(["excel_read", "pdf_create"]);
  });

  it("replays a whole connector loaded in an earlier turn", () => {
    const set = makeSet({ loaded: ["gmail-2"] });
    const initial = set.initialTools().map((t) => t.name);
    expect(initial.filter((n) => n.startsWith("mcp__gmail-2__"))).toHaveLength(23);
    expect(initial.some((n) => n.startsWith("mcp__gmail__"))).toBe(false);
  });
});

describe("prompt", () => {
  it("teaches filters, paging and list", () => {
    const section = makeSet().promptSection();
    expect(section).toContain('connectors: ["gmail-2"]');
    expect(section).toContain("page with `offset`");
    expect(section).toContain("list: true");
    expect(section).toContain("Connector Gmail 2 – info@lumea.dev (`mcp__gmail-2__*`): 23 tools");
  });
});

describe("performance", () => {
  it("indexes once and answers 100 queries fast", () => {
    const queries = ["create a linear issue", "send email", "invia una email", "merge pr", "list", "issue", "post message to slack channel",
      "cerca issue", "upload file", "delete comment"];
    const started = performance.now();
    const set = makeSet();
    set.find({ query: "warm up" });
    const indexed = performance.now();
    for (let i = 0; i < 100; i += 1) set.find({ query: queries[i % queries.length], connectors: i % 3 === 0 ? ["gmail"] : undefined });
    const done = performance.now();
    expect(indexed - started).toBeLessThan(250);
    expect(done - indexed).toBeLessThan(750);
  });
});

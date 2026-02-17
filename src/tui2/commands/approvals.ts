import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ConfirmOverlay } from "../overlays/confirm.js";
import { EditorOverlay } from "../overlays/editor-page.js";

export function cmdApprovals(api: CommandAPI): void {
  const { polpo, tui, args } = api;
  const sub = args[0]?.toLowerCase();

  // /approvals approve <requestId>
  if (sub === "approve" && args[1]) {
    const req = polpo.approveRequest(args[1], "tui-user");
    if (req) {
      tui.logSystem(theme.done(`Approved: ${req.gateName} (${req.id})`));
    } else {
      tui.logSystem(theme.error(`Approval request not found: ${args[1]}`));
    }
    tui.requestRender();
    return;
  }

  // /approvals reject <requestId>
  if (sub === "reject" && args[1]) {
    const feedback = args.slice(2).join(" ").trim() || "Rejected via TUI";
    const req = polpo.rejectRequest(args[1], feedback, "tui-user");
    if (req) {
      tui.logSystem(theme.failed(`Rejected: ${req.gateName} (${req.id})`));
    } else {
      tui.logSystem(theme.error(`Approval request not found: ${args[1]}`));
    }
    tui.requestRender();
    return;
  }

  // /approvals list or /approvals (default) — show pending
  const pending = polpo.getPendingApprovals();

  if (pending.length === 0) {
    // Show all if no pending
    const all = polpo.getAllApprovals();
    if (all.length === 0) {
      tui.logSystem("No approval requests");
      tui.requestRender();
      return;
    }
    // List all with status
    for (const req of all.slice(-20)) {
      const icon = req.status === "approved" ? theme.done("✓")
        : req.status === "rejected" ? theme.failed("✗")
        : req.status === "timeout" ? theme.warning("⏱")
        : theme.warning("⏳");
      const date = new Date(req.requestedAt).toLocaleString();
      tui.logSystem(`  ${icon} ${req.gateName} — ${req.status} (${theme.dim(date)})`);
    }
    tui.requestRender();
    return;
  }

  // Show picker for pending approvals
  const items = pending.map((req) => ({
    value: req.id,
    label: `${req.gateName}${req.taskId ? ` (task)` : ""}`,
    description: `Requested ${new Date(req.requestedAt).toLocaleString()}`,
  }));

  const picker = new PickerOverlay({
    title: `Pending Approvals (${pending.length})`,
    hint: "Enter: approve/reject · Esc: close",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      showApprovalDetail(api, item.value);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}

function showApprovalDetail(api: CommandAPI, requestId: string): void {
  const { polpo, tui } = api;
  const req = polpo.getApprovalRequest(requestId);
  if (!req) {
    tui.logSystem(theme.error(`Request not found: ${requestId}`));
    tui.requestRender();
    return;
  }

  const approvePicker = new PickerOverlay({
    title: `Approval: ${req.gateName}`,
    hint: `ID: ${req.id}`,
    items: [
      { value: "approve", label: "Approve", description: "Approve this request" },
      { value: "reject", label: "Reject", description: "Reject with feedback" },
      { value: "cancel", label: "Cancel", description: "Go back" },
    ],
    onSelect: (action) => {
      tui.hideOverlay();
      if (action.value === "approve") {
        const confirm = new ConfirmOverlay({
          message: `Approve "${req.gateName}"?`,
          onConfirm: () => {
            tui.hideOverlay();
            polpo.approveRequest(req.id, "tui-user");
            tui.logSystem(theme.done(`Approved: ${req.gateName}`));
            tui.requestRender();
          },
          onCancel: () => tui.hideOverlay(),
        });
        tui.showOverlay(confirm);
      } else if (action.value === "reject") {
        const editor = new EditorOverlay({
          title: "Rejection reason",
          initialText: "",
          tui: tui.tuiInstance,
          onSave: (feedback) => {
            tui.hideOverlay();
            const text = feedback.trim() || "Rejected via TUI";
            polpo.rejectRequest(req.id, text, "tui-user");
            tui.logSystem(theme.failed(`Rejected: ${req.gateName}`));
            tui.requestRender();
          },
          onCancel: () => tui.hideOverlay(),
        });
        tui.showOverlay(editor);
      }
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(approvePicker);
}

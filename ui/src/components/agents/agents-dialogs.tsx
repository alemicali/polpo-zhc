/**
 * Agent page dialogs — AddAgent, AddTeam, RemoveAgent.
 *
 * Each dialog consumes AgentsPageContext for state/actions,
 * eliminating prop drilling.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, FolderPlus, Trash2 } from "lucide-react";
import { useAsyncAction } from "@/hooks/use-polpo";
import { useAgentsPage } from "./agents-page-provider";
import { cn } from "@/lib/utils";

// ─── Add Agent Dialog ────────────────────────────────────

export function AddAgentDialog() {
  const { state, actions } = useAgentsPage();
  const { teams } = state;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [selectedTeam, setSelectedTeam] = useState(teams[0]?.name ?? "");

  const [handleSubmit, isSubmitting] = useAsyncAction(async () => {
    if (!name.trim()) return;
    await actions.addAgent(
      { name: name.trim(), role: role.trim() || undefined, model: model.trim() || undefined },
      selectedTeam || undefined,
    );
    setName("");
    setRole("");
    setModel("");
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) setSelectedTeam(teams[0]?.name ?? ""); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Agent</DialogTitle>
          <DialogDescription>
            Add a new agent to your team. Configure advanced settings later from the agent detail page.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          {teams.length > 1 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Team</span>
              <div className="flex flex-wrap gap-2">
                {teams.map(t => (
                  <button
                    key={t.name}
                    type="button"
                    className={cn(
                      "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                      selectedTeam === t.name
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "border-border/40 text-muted-foreground hover:border-primary/20",
                    )}
                    onClick={() => setSelectedTeam(t.name)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <span className="text-sm font-medium">Name</span>
            <Input placeholder="e.g. frontend-dev" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <p className="text-[11px] text-muted-foreground">Unique identifier. Use lowercase and hyphens.</p>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Role</span>
            <Input placeholder="e.g. Frontend developer specializing in React" value={role} onChange={(e) => setRole(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Helps the orchestrator assign the right tasks.</p>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <Input placeholder="e.g. claude-sonnet-4-20250514" value={model} onChange={(e) => setModel(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Leave empty to use the project default.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Team Dialog ─────────────────────────────────────

export function AddTeamDialog() {
  const { actions } = useAgentsPage();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [handleSubmit, isSubmitting] = useAsyncAction(async () => {
    if (!name.trim()) return;
    await actions.addTeam({ name: name.trim(), description: description.trim() || undefined });
    setName("");
    setDescription("");
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FolderPlus className="h-3.5 w-3.5" />
          Add Team
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Team</DialogTitle>
          <DialogDescription>
            Create a new team to organize your agents. You can move agents between teams later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          <div className="space-y-2">
            <span className="text-sm font-medium">Name</span>
            <Input placeholder="e.g. backend" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Description</span>
            <Input placeholder="e.g. Backend API and database team" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Team"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Remove Agent Confirmation Dialog ────────────────────

export function RemoveAgentDialog({ agentName }: { agentName: string }) {
  const { actions } = useAgentsPage();

  const [open, setOpen] = useState(false);
  const [handleRemove, isRemoving] = useAsyncAction(async () => {
    await actions.removeAgent(agentName);
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
          title="Remove agent"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove Agent</DialogTitle>
          <DialogDescription>
            Remove <strong>{agentName}</strong> from the team? This updates your <code className="text-[11px] bg-muted px-1 py-0.5 rounded">polpo.json</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isRemoving}>Cancel</Button>
          <Button variant="destructive" onClick={handleRemove} disabled={isRemoving}>
            {isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

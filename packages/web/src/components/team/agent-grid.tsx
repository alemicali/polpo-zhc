"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgents, useProcesses, type AddAgentRequest } from "@orchestra/react";
import { Plus, Trash2, User, Pencil, Check, Sparkles } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { toast } from "sonner";
import { TeamGenerateDialog } from "./team-generate-dialog";

export function AgentGrid() {
  const { agents, team, addAgent, removeAgent, renameTeam } = useAgents();
  const { processes } = useProcesses();
  const [addOpen, setAddOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [editingTeamName, setEditingTeamName] = useState(false);
  const [teamNameInput, setTeamNameInput] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [form, setForm] = useState<AddAgentRequest>({
    name: "",
    adapter: "claude-sdk",
  });

  const handleAdd = async () => {
    if (!form.name.trim()) return;
    try {
      await addAgent(form);
      setAddOpen(false);
      setForm({ name: "", adapter: "claude-sdk" });
      toast.success(`Agent ${form.name} added`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleRemove = async () => {
    if (!removeConfirm) return;
    try {
      await removeAgent(removeConfirm);
      toast.success(`Agent ${removeConfirm} removed`);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setRemoveConfirm(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {team && (
          <span className="text-sm text-muted-foreground flex items-center gap-2">
            Team:{" "}
            {editingTeamName ? (
              <span className="flex items-center gap-1">
                <Input
                  className="h-7 w-40 text-sm"
                  value={teamNameInput}
                  onChange={(e) => setTeamNameInput(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && teamNameInput.trim()) {
                      await renameTeam(teamNameInput.trim());
                      setEditingTeamName(false);
                      toast.success("Team renamed");
                    }
                    if (e.key === "Escape") setEditingTeamName(false);
                  }}
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={async () => {
                    if (teamNameInput.trim()) {
                      await renameTeam(teamNameInput.trim());
                      setEditingTeamName(false);
                      toast.success("Team renamed");
                    }
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="font-medium text-foreground">{team.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => { setTeamNameInput(team.name); setEditingTeamName(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </span>
            )}
          </span>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setGenOpen(true)}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Generate with AI
          </Button>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Agent
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Agent</DialogTitle>
              <DialogDescription>
                Configure a new agent for the team
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                placeholder="Agent name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Select
                value={form.adapter}
                onValueChange={(v) => setForm({ ...form, adapter: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-sdk">Claude SDK</SelectItem>
                  <SelectItem value="generic">Generic CLI</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Model (optional)"
                value={form.model ?? ""}
                onChange={(e) =>
                  setForm({ ...form, model: e.target.value || undefined })
                }
              />
              <Input
                placeholder="Role (optional)"
                value={form.role ?? ""}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value || undefined })
                }
              />
              <Textarea
                placeholder="System prompt (optional)"
                value={form.systemPrompt ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    systemPrompt: e.target.value || undefined,
                  })
                }
                rows={4}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAdd} disabled={!form.name.trim()}>
                Add
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
        <TeamGenerateDialog open={genOpen} onOpenChange={setGenOpen} />
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No agents configured. Add one to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => {
            const proc = processes.find(
              (p) => p.agentName === agent.name && p.alive
            );

            return (
              <Card key={agent.name}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                        <User className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <CardTitle className="text-sm">{agent.name}</CardTitle>
                    </div>
                    {proc ? (
                      <Shimmer className="w-10 h-3">{" "}</Shimmer>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        idle
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs">
                    {agent.adapter}
                    {agent.model ? ` · ${agent.model}` : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {agent.role && (
                    <p className="text-xs text-muted-foreground">{agent.role}</p>
                  )}
                  {agent.skills && agent.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {agent.skills.map((s) => (
                        <Badge key={s} variant="outline" className="text-[10px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {proc && (
                    <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                      Working on: {proc.taskId}
                      {proc.activity?.lastTool && (
                        <span className="ml-1">
                          ({proc.activity.lastTool})
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex justify-end">
                    {!agent.volatile && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setRemoveConfirm(agent.name)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Remove Agent Confirmation */}
      <Dialog open={!!removeConfirm} onOpenChange={(open) => !open && setRemoveConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove agent?</DialogTitle>
            <DialogDescription>
              This will remove <strong>&ldquo;{removeConfirm}&rdquo;</strong> from the team. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemove}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

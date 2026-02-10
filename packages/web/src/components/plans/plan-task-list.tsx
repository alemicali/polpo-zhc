"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTasks, useAgents, useOrchestra } from "@orchestra/react";
import {
  STATUS_DOT_COLORS,
  formatDuration,
  formatScore,
} from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import {
  RotateCcw,
  MoreVertical,
  Plus,
  Trash2,
  UserRoundCog,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

const isEditable = (status: string) =>
  status === "pending" || status === "failed";

export function PlanTaskList({
  planName,
  planStatus,
}: {
  planName: string;
  planStatus?: string;
}) {
  const { tasks, retryTask, deleteTask, createTask } = useTasks();
  const { agents } = useAgents();
  const { client } = useOrchestra();
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editTask, setEditTask] = useState<{ id: string; description: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const planTasks = tasks
    .filter((t) => t.group === planName)
    .sort((a, b) => {
      const order: Record<string, number> = {
        in_progress: 0,
        assigned: 1,
        review: 2,
        pending: 3,
        done: 4,
        failed: 5,
      };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

  const canEdit = planStatus === "active" || planStatus === "failed";

  const handleReassign = useCallback(
    async (taskId: string, agentName: string) => {
      try {
        await client.updateTask(taskId, { assignTo: agentName });
        toast.success(`Reassigned to ${agentName}`);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [client]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await deleteTask(deleteConfirm.id);
      toast.success("Task removed from plan");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setDeleteConfirm(null);
  }, [deleteTask, deleteConfirm]);

  const handleSaveEdit = useCallback(async () => {
    if (!editTask) return;
    try {
      await client.updateTask(editTask.id, { description: editTask.description });
      toast.success("Description updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setEditTask(null);
  }, [client, editTask]);

  if (planTasks.length === 0 && !canEdit) {
    return (
      <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
        {planStatus === "draft"
          ? "This plan is a draft. Press Execute to launch tasks."
          : "No tasks yet. Tasks will appear here once the plan is executed."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Table */}
      {planTasks.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]" />
                <TableHead>Title</TableHead>
                <TableHead className="w-[100px]">Agent</TableHead>
                <TableHead className="w-[70px] text-right">Score</TableHead>
                <TableHead className="w-[80px] text-right">Duration</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {planTasks.map((task) => {
                const taskEditable = canEdit && isEditable(task.status);
                return (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer"
                    onClick={() =>
                      router.push(
                        `/projects/${params.projectId}/tasks/${task.id}`
                      )
                    }
                  >
                    {/* Status dot */}
                    <TableCell>
                      <span
                        className={cn(
                          "inline-block h-2.5 w-2.5 rounded-full",
                          STATUS_DOT_COLORS[task.status],
                          (task.status === "in_progress" ||
                            task.status === "assigned") &&
                            "animate-pulse"
                        )}
                      />
                    </TableCell>

                    {/* Title */}
                    <TableCell className="font-medium">
                      {task.title}
                    </TableCell>

                    {/* Agent */}
                    <TableCell className="text-xs text-muted-foreground">
                      {task.assignTo || "—"}
                    </TableCell>

                    {/* Score */}
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatScore(task.result?.assessment?.globalScore)}
                    </TableCell>

                    {/* Duration */}
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {task.result?.duration
                        ? formatDuration(task.result.duration)
                        : "—"}
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div
                        className="flex justify-end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {task.status === "failed" && !taskEditable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => retryTask(task.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {taskEditable && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  setEditTask({
                                    id: task.id,
                                    description: task.description,
                                  })
                                }
                              >
                                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                                Description
                              </DropdownMenuItem>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <UserRoundCog className="mr-2 h-3.5 w-3.5" />{" "}
                                  Reassign
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {agents.map((a) => (
                                    <DropdownMenuItem
                                      key={a.name}
                                      onClick={() =>
                                        handleReassign(task.id, a.name)
                                      }
                                      className={cn(
                                        a.name === task.assignTo &&
                                          "font-medium"
                                      )}
                                    >
                                      {a.name}
                                      {a.name === task.assignTo && (
                                        <span className="ml-auto text-[10px] text-muted-foreground">
                                          current
                                        </span>
                                      )}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              {task.status === "failed" && (
                                <DropdownMenuItem
                                  onClick={() => retryTask(task.id)}
                                >
                                  <RotateCcw className="mr-2 h-3.5 w-3.5" />{" "}
                                  Retry
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  setDeleteConfirm({
                                    id: task.id,
                                    title: task.title,
                                  })
                                }
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove
                                from Plan
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add Task button */}
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          className="w-full border-dashed"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Task to Plan
        </Button>
      )}

      {/* Add Task Dialog */}
      <AddTaskDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agents={agents.map((a) => a.name)}
        group={planName}
        onCreate={createTask}
      />

      {/* Edit Description Dialog */}
      <Dialog open={!!editTask} onOpenChange={(open) => !open && setEditTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Description</DialogTitle>
          </DialogHeader>
          <Textarea
            value={editTask?.description ?? ""}
            onChange={(e) =>
              setEditTask((prev) =>
                prev ? { ...prev, description: e.target.value } : null
              )
            }
            rows={5}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSaveEdit();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTask(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove task from plan?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <strong>&ldquo;{deleteConfirm?.title}&rdquo;</strong> from the
              plan. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddTaskDialog({
  open,
  onOpenChange,
  agents,
  group,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: string[];
  group: string;
  onCreate: (req: {
    title: string;
    description: string;
    assignTo: string;
    group: string;
  }) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignTo, setAssignTo] = useState(agents[0] ?? "");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !assignTo) return;
    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim() || title.trim(),
        assignTo,
        group,
      });
      toast.success(`Task "${title}" added to plan`);
      setTitle("");
      setDescription("");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Task to Plan</DialogTitle>
          <DialogDescription>
            Add a new task to the &ldquo;{group}&rdquo; plan group.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <Textarea
            placeholder="Description (optional — defaults to title)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <Select value={assignTo} onValueChange={setAssignTo}>
            <SelectTrigger>
              <SelectValue placeholder="Assign to agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || !assignTo || submitting}
          >
            Add Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

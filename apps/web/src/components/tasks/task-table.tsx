"use client";

import { useState, useMemo, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTasks, type TaskStatus } from "@orchestra/react";
import { TaskStatusBadge } from "./task-status-badge";
import { formatDuration, formatScore, formatTimeAgo } from "@/lib/orchestra";
import { Search, RotateCcw, Trash2, Eraser } from "lucide-react";
import { toast } from "sonner";

const ALL_STATUSES: TaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "review",
  "done",
  "failed",
];

export function TaskTable() {
  const { tasks, retryTask, deleteTask } = useTasks();
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await deleteTask(deleteConfirm.id);
      toast.success("Task deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setDeleteConfirm(null);
  }, [deleteTask, deleteConfirm]);

  const handleConfirmClear = useCallback(async () => {
    const finished = tasks.filter((t) => t.status === "done" || t.status === "failed");
    for (const t of finished) { try { await deleteTask(t.id); } catch {} }
    toast.success(`Cleared ${finished.length} tasks`);
    setClearConfirm(false);
  }, [tasks, deleteTask]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.group) set.add(t.group);
    }
    return Array.from(set).sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (groupFilter !== "all" && t.group !== groupFilter) return false;
      if (
        search &&
        !t.title.toLowerCase().includes(search.toLowerCase()) &&
        !t.id.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [tasks, statusFilter, groupFilter, search]);

  return (
    <>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {groups.length > 0 && (
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {filtered.length} of {tasks.length}
        </span>
        {tasks.filter((t) => t.status === "failed").length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={async () => {
              const failed = tasks.filter((t) => t.status === "failed");
              for (const t of failed) { try { await retryTask(t.id); } catch {} }
              toast.success(`Retried ${failed.length} tasks`);
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry All Failed
          </Button>
        )}
        {tasks.filter((t) => t.status === "done" || t.status === "failed").length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={() => setClearConfirm(true)}
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" />
            Clear Finished
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-[120px]">Agent</TableHead>
              <TableHead className="w-[120px]">Group</TableHead>
              <TableHead className="w-[80px] text-right">Score</TableHead>
              <TableHead className="w-[80px] text-right">Duration</TableHead>
              <TableHead className="w-[80px] text-right">Updated</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  No tasks found
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((task) => (
                <TableRow
                  key={task.id}
                  className="cursor-pointer"
                  onClick={() =>
                    router.push(
                      `/projects/${params.projectId}/tasks/${task.id}`
                    )
                  }
                >
                  <TableCell>
                    <TaskStatusBadge status={task.status} />
                  </TableCell>
                  <TableCell className="font-medium">{task.title}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {task.assignTo || "—"}
                  </TableCell>
                  <TableCell>
                    {task.group && (
                      <Badge variant="outline" className="text-[10px]">
                        {task.group}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {formatScore(task.result?.assessment?.globalScore)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                    {task.result?.duration
                      ? formatDuration(task.result.duration)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatTimeAgo(task.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {task.status === "failed" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => retryTask(task.id)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(task.status === "done" || task.status === "failed") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteConfirm({ id: task.id, title: task.title })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete single task confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>&ldquo;{deleteConfirm?.title}&rdquo;</strong>. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear finished confirmation */}
      <Dialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear all finished tasks?</DialogTitle>
            <DialogDescription>
              This will permanently delete all tasks with status &ldquo;done&rdquo; or &ldquo;failed&rdquo; ({tasks.filter((t) => t.status === "done" || t.status === "failed").length} tasks). This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmClear}>
              <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

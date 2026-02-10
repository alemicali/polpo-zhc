"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useTasks,
  usePlans,
  useAgents,
  useOrchestra,
} from "@orchestra/react";
import {
  LayoutDashboard,
  ListTodo,
  Map,
  Users,
  BookOpen,
  ScrollText,
  MessageCircle,
  Settings,
  RotateCcw,
  Square,
  Play,
  Plus,
  Eraser,
  Sparkles,
  ClipboardCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const { client } = useOrchestra();
  const { tasks, retryTask, deleteTask } = useTasks();
  const { plans, executePlan, abortPlan } = usePlans();
  const { agents } = useAgents();
  const basePath = `/projects/${params.projectId}`;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const go = useCallback(
    (path: string) => {
      router.push(path);
      setOpen(false);
    },
    [router]
  );

  const failedTasks = tasks.filter((t) => t.status === "failed");
  const finishedTasks = tasks.filter(
    (t) => t.status === "done" || t.status === "failed"
  );
  const runningTasks = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "assigned"
  );
  const assessableTasks = tasks.filter(
    (t) => t.status === "done" || t.status === "failed"
  );
  const draftPlans = plans.filter((p) => p.status === "draft");
  const activePlans = plans.filter((p) => p.status === "active");

  const retryAllFailed = useCallback(async () => {
    for (const t of failedTasks) {
      try { await retryTask(t.id); } catch {}
    }
    toast.success(`Retried ${failedTasks.length} tasks`);
    setOpen(false);
  }, [failedTasks, retryTask]);

  const clearFinished = useCallback(() => {
    setOpen(false);
    setClearConfirm(true);
  }, []);

  const handleConfirmClear = useCallback(async () => {
    for (const t of finishedTasks) {
      try { await deleteTask(t.id); } catch {}
    }
    toast.success(`Cleared ${finishedTasks.length} tasks`);
    setClearConfirm(false);
  }, [finishedTasks, deleteTask]);

  const handleConfirmKill = useCallback(async () => {
    for (const t of runningTasks) {
      try { await client.killTask(t.id); } catch {}
    }
    toast.success(`Killed ${runningTasks.length} running tasks`);
    setKillConfirm(false);
  }, [runningTasks, client]);

  return (
    <>
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => go(basePath)}>
            <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/tasks`)}>
            <ListTodo className="mr-2 h-4 w-4" /> Tasks
            {tasks.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">{tasks.length}</span>
            )}
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/plans`)}>
            <Map className="mr-2 h-4 w-4" /> Plans
            {plans.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">{plans.length}</span>
            )}
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/team`)}>
            <Users className="mr-2 h-4 w-4" /> Team
            <span className="ml-auto text-xs text-muted-foreground">{agents.length} agents</span>
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/memory`)}>
            <BookOpen className="mr-2 h-4 w-4" /> Memory
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/logs`)}>
            <ScrollText className="mr-2 h-4 w-4" /> Logs
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/chat`)}>
            <MessageCircle className="mr-2 h-4 w-4" /> Chat
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/settings`)}>
            <Settings className="mr-2 h-4 w-4" /> Settings
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Tasks">
          <CommandItem onSelect={() => go(`${basePath}/chat`)}>
            <Plus className="mr-2 h-4 w-4" /> New Task (via Chat)
          </CommandItem>
          {failedTasks.length > 0 && (
            <CommandItem onSelect={retryAllFailed}>
              <RotateCcw className="mr-2 h-4 w-4" /> Retry All Failed
              <span className="ml-auto text-xs text-status-failed">{failedTasks.length}</span>
            </CommandItem>
          )}
          {finishedTasks.length > 0 && (
            <CommandItem onSelect={clearFinished}>
              <Eraser className="mr-2 h-4 w-4" /> Clear Finished Tasks
              <span className="ml-auto text-xs text-muted-foreground">{finishedTasks.length}</span>
            </CommandItem>
          )}
          {runningTasks.length > 0 && (
            <CommandItem onSelect={() => { setOpen(false); setKillConfirm(true); }}>
              <XCircle className="mr-2 h-4 w-4" /> Kill All Running
              <span className="ml-auto text-xs text-status-running">{runningTasks.length}</span>
            </CommandItem>
          )}
          {assessableTasks.length > 0 && (
            <CommandItem onSelect={async () => {
              let count = 0;
              for (const t of assessableTasks) {
                try { await client.reassessTask(t.id); count++; } catch {}
              }
              toast.success(`Reassessing ${count} tasks`);
              setOpen(false);
            }}>
              <ClipboardCheck className="mr-2 h-4 w-4" /> Reassess All Finished
              <span className="ml-auto text-xs text-muted-foreground">{assessableTasks.length}</span>
            </CommandItem>
          )}
        </CommandGroup>

        {(draftPlans.length > 0 || activePlans.length > 0) && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Plans">
              {draftPlans.map((p) => (
                <CommandItem
                  key={p.id}
                  onSelect={async () => {
                    try {
                      const r = await executePlan(p.id);
                      toast.success(`Launched ${r.tasks.length} tasks`);
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                    setOpen(false);
                  }}
                >
                  <Play className="mr-2 h-4 w-4" /> Execute: {p.name}
                </CommandItem>
              ))}
              {activePlans.map((p) => (
                <CommandItem
                  key={p.id}
                  onSelect={async () => {
                    try {
                      const r = await abortPlan(p.id);
                      toast.success(`Aborted ${r.aborted} tasks`);
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                    setOpen(false);
                  }}
                >
                  <Square className="mr-2 h-4 w-4" /> Abort: {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="AI Generate">
          <CommandItem onSelect={() => go(`${basePath}/team`)}>
            <Sparkles className="mr-2 h-4 w-4" /> Generate Team with AI
          </CommandItem>
          <CommandItem onSelect={() => go(`${basePath}/chat`)}>
            <Sparkles className="mr-2 h-4 w-4" /> Generate Plan with AI
          </CommandItem>
        </CommandGroup>

        {tasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Go to Task">
              {tasks.slice(0, 20).map((t) => (
                <CommandItem key={t.id} onSelect={() => go(`${basePath}/tasks/${t.id}`)}>
                  <span className="mr-2 text-xs">{t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "●"}</span>
                  {t.title}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>

    {/* Clear Finished confirmation */}
    <Dialog open={clearConfirm} onOpenChange={setClearConfirm}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear all finished tasks?</DialogTitle>
          <DialogDescription>
            This will permanently delete {finishedTasks.length} task{finishedTasks.length !== 1 ? "s" : ""} with status &ldquo;done&rdquo; or &ldquo;failed&rdquo;. This action cannot be undone.
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

    {/* Kill All Running confirmation */}
    <Dialog open={killConfirm} onOpenChange={setKillConfirm}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Kill all running tasks?</DialogTitle>
          <DialogDescription>
            This will terminate {runningTasks.length} running task{runningTasks.length !== 1 ? "s" : ""}. The associated agents will be stopped.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setKillConfirm(false)}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirmKill}>
            <XCircle className="mr-1.5 h-3.5 w-3.5" /> Kill All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

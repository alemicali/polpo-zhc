/**
 * New group + group settings dialogs.
 */
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  DEFAULT_ROOM_SETTINGS,
  resolveRoomSettings,
  type Room,
  type RoomInput,
  type RoomSettings,
} from "@/lib/rooms-api";
import { FieldLabel, GroupSettingsFields, MemberPicker, type GroupFormValue } from "./group-form";
import type { GroupMember } from "./use-member-directory";

const DIALOG_CLASS = "flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-lg";

function defaultTitle(agentIds: string[], resolve: (id: string) => GroupMember): string {
  const names = agentIds.map((id) => resolve(id).name);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function sameSettings(a: Required<RoomSettings>, b: Required<RoomSettings>): boolean {
  return (Object.keys(a) as (keyof RoomSettings)[]).every((key) => a[key] === b[key]);
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── New group ───────────────────────────────────────────

export function NewGroupDialog({ open, onOpenChange, members, membersLoading, resolve, onCreate, initialAgents }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: GroupMember[];
  membersLoading?: boolean;
  resolve: (id: string) => GroupMember;
  onCreate: (input: RoomInput) => Promise<unknown>;
  /** Agents preselected when the dialog opens (e.g. the agent picked in the chat). */
  initialAgents?: string[];
}) {
  const blank = (): GroupFormValue => ({ title: "", agents: [...(initialAgents ?? [])], settings: DEFAULT_ROOM_SETTINGS });
  const [value, setValue] = useState<GroupFormValue>(blank);
  const [saving, setSaving] = useState(false);

  // Start from a blank form (plus the preselection) every time the dialog opens
  // (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(blank());
  }

  const handleOpenChange = (next: boolean) => {
    if (saving) return;
    onOpenChange(next);
  };

  const submit = async () => {
    if (value.agents.length === 0 || saving) return;
    setSaving(true);
    try {
      await onCreate({
        title: value.title.trim() || defaultTitle(value.agents, resolve),
        agents: value.agents,
        settings: value.settings,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error("Could not create the group", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>
            Talk with several agents at once. They answer when you @mention them, or when your message is meant for them.
          </DialogDescription>
        </DialogHeader>
        <form
          id="new-group-form"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-2"
        >
          <div className="space-y-2">
            <FieldLabel>Title</FieldLabel>
            <Input
              autoFocus
              placeholder={value.agents.length ? defaultTitle(value.agents, resolve) : "e.g. Launch plan"}
              value={value.title}
              onChange={(e) => setValue({ ...value, title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel hint={value.agents.length ? `${value.agents.length} selected` : "Pick at least one"}>Agents</FieldLabel>
            <MemberPicker
              members={members}
              isLoading={membersLoading}
              selected={value.agents}
              onChange={(agents) => setValue({ ...value, agents })}
            />
          </div>
          <div className="space-y-3">
            <FieldLabel>Settings</FieldLabel>
            <GroupSettingsFields settings={value.settings} onChange={(settings) => setValue({ ...value, settings })} />
          </div>
        </form>
        <DialogFooter className="shrink-0 border-t border-border/50 px-6 py-4">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="submit" form="new-group-form" disabled={value.agents.length === 0 || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Group settings ──────────────────────────────────────

export function GroupSettingsDialog({ room, open, onOpenChange, members, membersLoading, onSave, onDelete }: {
  room: Room;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: GroupMember[];
  membersLoading?: boolean;
  onSave: (patch: Partial<RoomInput>) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const initial = (): GroupFormValue => ({
    title: room.title,
    agents: [...room.agents],
    settings: resolveRoomSettings(room.settings),
  });
  const [value, setValue] = useState<GroupFormValue>(initial);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed the form from the latest room every time the dialog opens.
  // (adjusted during render, not in an effect)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initial());
  }

  const patch: Partial<RoomInput> = {};
  const title = value.title.trim();
  if (title && title !== room.title) patch.title = title;
  if (!sameMembers(value.agents, room.agents)) patch.agents = value.agents;
  if (!sameSettings(value.settings, resolveRoomSettings(room.settings))) patch.settings = value.settings;
  const dirty = Object.keys(patch).length > 0;
  const valid = value.agents.length > 0 && title.length > 0;

  const save = async () => {
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      await onSave(patch);
      toast.success("Group updated");
      onOpenChange(false);
    } catch (error) {
      toast.error("Could not update the group", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await onDelete();
      setConfirmDelete(false);
      onOpenChange(false);
      toast.success("Group deleted");
    } catch (error) {
      toast.error("Could not delete the group", { description: errorText(error) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
        <DialogContent className={DIALOG_CLASS}>
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle>Group settings</DialogTitle>
            <DialogDescription>Changes apply to the next messages in this group.</DialogDescription>
          </DialogHeader>
          <form
            id="group-settings-form"
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-2"
          >
            <div className="space-y-2">
              <FieldLabel>Title</FieldLabel>
              <Input value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <FieldLabel hint={value.agents.length ? `${value.agents.length} in the group` : "Keep at least one"}>Agents</FieldLabel>
              <MemberPicker
                members={members}
                isLoading={membersLoading}
                selected={value.agents}
                onChange={(agents) => setValue({ ...value, agents })}
              />
            </div>
            <div className="space-y-3">
              <FieldLabel>Settings</FieldLabel>
              <GroupSettingsFields settings={value.settings} onChange={(settings) => setValue({ ...value, settings })} />
            </div>
            <Separator className="bg-border/50" />
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Delete group</p>
                <p className="text-[11px] text-muted-foreground">Removes the group and its transcript for everyone.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </form>
          <DialogFooter className="shrink-0 border-t border-border/50 px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" form="group-settings-form" disabled={!dirty || !valid || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => { if (!deleting) setConfirmDelete(next); }}
        title="Delete this group?"
        description={<>“{room.title}” and all its messages will be deleted. This cannot be undone.</>}
        confirmLabel="Delete group"
        destructive
        loading={deleting}
        onConfirm={() => { void remove(); }}
      />
    </>
  );
}

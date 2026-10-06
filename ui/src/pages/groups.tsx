/**
 * Groups — conversations between a person and several agents at once.
 *
 * /groups            list (+ empty panel on desktop)
 * /groups/:roomId    the conversation (list stays visible on desktop)
 *
 * The server decides who answers (mentions, intent, agent-to-agent); this page
 * posts the person's messages and shows everyone's messages live.
 */
import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GroupList } from "@/components/groups/group-list";
import { GroupConversation, GroupsEmptyPanel } from "@/components/groups/group-conversation";
import { GroupSettingsDialog, NewGroupDialog } from "@/components/groups/group-dialogs";
import { useMemberDirectory } from "@/components/groups/use-member-directory";
import { useGroups } from "@/hooks/use-rooms";
import type { RoomInput } from "@/lib/rooms-api";
import { cn } from "@/lib/utils";

function groupPath(roomId: string): string {
  return `/groups/${encodeURIComponent(roomId)}`;
}

export function GroupsPage() {
  const params = useParams<{ roomId?: string }>();
  const activeRoomId = params.roomId ?? null;
  const navigate = useNavigate();
  const { members, resolve, isLoading: membersLoading } = useMemberDirectory();
  const groups = useGroups(activeRoomId);
  const { room, createRoom, updateRoom, deleteRoom, refreshRooms } = groups;

  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus the composer on open only with a real keyboard (no on-screen keyboard pop).
  const [autoFocusComposer] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px) and (pointer: fine)").matches,
  );

  const openRoom = useCallback((id: string) => navigate(groupPath(id)), [navigate]);
  const backToList = useCallback(() => navigate("/groups"), [navigate]);

  const handleCreate = useCallback(async (input: RoomInput) => {
    const created = await createRoom(input);
    navigate(groupPath(created.id));
  }, [createRoom, navigate]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <GroupList
        className={cn(
          "w-full lg:w-80 lg:shrink-0 lg:border-r lg:border-border/30",
          activeRoomId && "max-lg:hidden",
        )}
        rooms={groups.rooms}
        loading={groups.roomsLoading}
        error={groups.roomsError}
        activeRoomId={activeRoomId}
        unread={groups.unread}
        resolve={resolve}
        onSelect={openRoom}
        onNew={() => setNewOpen(true)}
        onRetry={() => { void refreshRooms(); }}
      />

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !activeRoomId && "max-lg:hidden")}>
        {activeRoomId ? (
          <GroupConversation
            room={room}
            roomMissing={groups.roomMissing}
            messages={groups.messages}
            loading={groups.messagesLoading}
            error={groups.messagesError}
            typingAgents={groups.typingAgents}
            resolve={resolve}
            onSend={groups.send}
            onBack={backToList}
            onOpenSettings={() => setSettingsOpen(true)}
            onRetry={groups.reloadConversation}
            autoFocusComposer={autoFocusComposer}
          />
        ) : (
          <GroupsEmptyPanel onNew={() => setNewOpen(true)} hasGroups={groups.rooms.length > 0} />
        )}
      </div>

      <NewGroupDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        members={members}
        membersLoading={membersLoading}
        resolve={resolve}
        onCreate={handleCreate}
      />
      {room && room.kind !== "telegram" && (
        <GroupSettingsDialog
          room={room}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          members={members}
          membersLoading={membersLoading}
          onSave={(patch) => updateRoom(room.id, patch)}
          onDelete={async () => {
            await deleteRoom(room.id);
            navigate("/groups", { replace: true });
          }}
        />
      )}
    </div>
  );
}

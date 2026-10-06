/**
 * Member directory for Groups: the orchestrator ("polpo") plus every agent
 * from /api/v1/agents, with display names, roles and avatar paths.
 */
import { useMemo } from "react";
import { useAgents } from "@polpo-ai/react";
import { ORCHESTRATOR_MEMBER_ID } from "@/lib/rooms-api";

export interface GroupMember {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  isOrchestrator: boolean;
  /** False when the id no longer matches a configured agent. */
  known: boolean;
}

const ORCHESTRATOR_MEMBER: GroupMember = {
  id: ORCHESTRATOR_MEMBER_ID,
  name: "Polpo",
  role: "Orchestrator",
  isOrchestrator: true,
  known: true,
};

/** Every member that can be added to a group: Polpo first, then the agents. */
export function useMemberDirectory() {
  const { agents, isLoading } = useAgents();
  return useMemo(() => {
    const list: GroupMember[] = [ORCHESTRATOR_MEMBER];
    for (const agent of agents ?? []) {
      if (agent.name === ORCHESTRATOR_MEMBER_ID) continue;
      list.push({
        id: agent.name,
        name: agent.identity?.displayName || agent.name,
        avatar: agent.identity?.avatar,
        role: agent.identity?.title || agent.role,
        isOrchestrator: false,
        known: true,
      });
    }
    const byId = new Map(list.map((member) => [member.id, member]));
    const resolve = (id: string, fallbackName?: string): GroupMember => byId.get(id) ?? {
      id,
      name: fallbackName || id,
      isOrchestrator: false,
      known: false,
    };
    return { members: list, resolve, isLoading: isLoading && (agents?.length ?? 0) === 0 };
  }, [agents, isLoading]);
}

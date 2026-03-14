/**
 * Route dependency interfaces.
 *
 * Each route factory accepts a `() => XxxDeps` thunk that is evaluated
 * at request time (after orchestrator init).  This decouples routes from
 * the Orchestrator god-object so the cloud can wire stores directly.
 */

import type { TaskStore } from "../core/task-store.js";
import type { RunStore } from "../core/run-store.js";
import type { LogStore } from "../core/log-store.js";
import type { VaultStore } from "../core/vault-store.js";
import type { PlaybookStore } from "../core/playbook-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { PeerStore } from "../core/peer-store.js";

// ── Store-centric deps ───────────────────────────────────────────────

export interface VaultRouteDeps {
  vaultStore?: VaultStore;
}

export interface ChatRouteDeps {
  sessionStore?: SessionStore;
}

export interface PeerRouteDeps {
  peerStore?: PeerStore;
}

// ── Task deps ────────────────────────────────────────────────────────

export interface TaskRouteDeps {
  taskStore: TaskStore;
  addTask: (...args: any[]) => Promise<any>;
  deleteTask: (...args: any[]) => Promise<any>;
  retryTask: (...args: any[]) => Promise<any>;
  killTask: (...args: any[]) => Promise<any>;
  reassessTask: (...args: any[]) => Promise<any>;
  forceFailTask: (...args: any[]) => Promise<any>;
  updateTaskDescription: (...args: any[]) => Promise<any>;
  updateTaskAssignment: (...args: any[]) => Promise<any>;
  updateTaskExpectations: (...args: any[]) => Promise<any>;
}

// ── Agent deps ───────────────────────────────────────────────────────

export interface AgentRouteDeps {
  getAgents: () => Promise<any[]>;
  addAgent: (...args: any[]) => Promise<any>;
  removeAgent: (...args: any[]) => Promise<any>;
  updateAgent: (...args: any[]) => Promise<any>;
  getTeams: () => Promise<any[]>;
  getTeam: (name?: string) => Promise<any>;
  addTeam: (...args: any[]) => Promise<any>;
  removeTeam: (...args: any[]) => Promise<any>;
  renameTeam: (oldName: string, newName: string) => Promise<any>;
  getStore: () => TaskStore;
  getRunStore: () => RunStore;
  getPolpoDir: () => string;
}

// ── Mission deps ─────────────────────────────────────────────────────

export interface MissionRouteDeps {
  getAllMissions: () => Promise<any[]>;
  getResumableMissions: () => Promise<any[]>;
  getMission: (missionId: string) => Promise<any>;
  saveMission: (...args: any[]) => Promise<any>;
  updateMission: (missionId: string, updates: any) => Promise<any>;
  deleteMission: (missionId: string) => Promise<any>;
  executeMission: (missionId: string) => Promise<any>;
  resumeMission: (missionId: string, opts?: any) => Promise<any>;
  abortGroup: (groupName: string) => Promise<any>;
  getActiveCheckpoints: () => any[];
  resumeCheckpointByMissionId: (missionId: string, checkpointName: string) => Promise<any>;
  getActiveDelays: () => any[];
  addMissionTask: (missionId: string, task: any) => Promise<any>;
  updateMissionTask: (missionId: string, taskTitle: string, updates: any) => Promise<any>;
  removeMissionTask: (missionId: string, taskTitle: string) => Promise<any>;
  reorderMissionTasks: (missionId: string, titles: string[]) => Promise<any>;
  addMissionCheckpoint: (missionId: string, checkpoint: any) => Promise<any>;
  updateMissionCheckpoint: (missionId: string, checkpointName: string, updates: any) => Promise<any>;
  removeMissionCheckpoint: (missionId: string, checkpointName: string) => Promise<any>;
  addMissionDelay: (missionId: string, delay: any) => Promise<any>;
  updateMissionDelay: (missionId: string, delayName: string, updates: any) => Promise<any>;
  removeMissionDelay: (missionId: string, delayName: string) => Promise<any>;
  addMissionQualityGate: (missionId: string, gate: any) => Promise<any>;
  updateMissionQualityGate: (missionId: string, gateName: string, updates: any) => Promise<any>;
  removeMissionQualityGate: (missionId: string, gateName: string) => Promise<any>;
  addMissionTeamMember: (missionId: string, member: any) => Promise<any>;
  updateMissionTeamMember: (missionId: string, memberName: string, updates: any) => Promise<any>;
  removeMissionTeamMember: (missionId: string, memberName: string) => Promise<any>;
  updateMissionNotifications: (missionId: string, notifications: any) => Promise<any>;
}

// ── Playbook deps ────────────────────────────────────────────────────

export interface PlaybookRouteDeps {
  playbookStore: PlaybookStore;
  saveMission: (...args: any[]) => Promise<any>;
  executeMission: (missionId: string) => Promise<any>;
}

// ── Approval deps ────────────────────────────────────────────────────

export interface ApprovalRouteDeps {
  getAllApprovals: (status?: string) => Promise<any[]>;
  getApprovalRequest: (id: string) => Promise<any>;
  approveRequest: (id: string, resolvedBy?: string, note?: string) => Promise<any>;
  rejectRequest: (id: string, feedback: string, resolvedBy?: string) => Promise<any>;
  canRejectRequest: (id: string) => Promise<{ allowed: boolean; rejectionCount?: number; maxRejections?: number }>;
  getPendingApprovals: () => Promise<any[]>;
}

// ── Notification deps ────────────────────────────────────────────────

export interface NotificationRouterLike {
  getStore: () => any;
  sendDirect: (opts: any) => Promise<any>;
  getRules: () => any[];
  addRule: (rule: any) => void;
  removeRule: (ruleId: string) => boolean;
  getChannelIds: () => string[];
  testChannels: () => Promise<Record<string, boolean>>;
}

export interface NotificationRouteDeps {
  getNotificationRouter: () => NotificationRouterLike | undefined;
}

// ── Schedule deps ────────────────────────────────────────────────────

export interface SchedulerLike {
  getAllSchedules: () => any[];
  getScheduleByMissionId: (missionId: string) => any;
  registerMission: (mission: any) => any;
  unregisterMission: (missionId: string) => boolean;
}

export interface ScheduleRouteDeps {
  getScheduler: () => SchedulerLike | undefined;
  getMission: (missionId: string) => Promise<any>;
  updateMission: (missionId: string, updates: any) => Promise<any>;
}

// ── Watcher deps ─────────────────────────────────────────────────────

export interface WatcherManagerLike {
  getAll: () => any[];
  getActive: () => any[];
  create: (opts: any) => any;
  remove: (watcherId: string) => boolean;
}

export interface WatcherRouteDeps {
  getWatcherManager: () => WatcherManagerLike | undefined;
  taskStore: TaskStore;
}

// ── State deps ───────────────────────────────────────────────────────

export interface StateRouteDeps {
  taskStore: TaskStore;
  getConfig: () => any;
  hasMemory: () => Promise<boolean>;
  getMemory: () => Promise<any>;
  saveMemory: (content: any) => Promise<void>;
  hasAgentMemory: (agentName: string) => Promise<boolean>;
  getAgentMemory: (agentName: string) => Promise<any>;
  saveAgentMemory: (agentName: string, content: any) => Promise<void>;
  getLogStore: () => LogStore | undefined;
}

// ── Skill deps ───────────────────────────────────────────────────────

export interface SkillRouteDeps {
  getPolpoDir: () => string;
  getWorkDir: () => string;
  getAgents: () => Promise<any[]>;
}

// ── Config deps ──────────────────────────────────────────────────────

export interface ConfigRouteDeps {
  getConfig: () => any;
  reloadConfig: () => Promise<boolean>;
  getPolpoDir: () => string;
  getNotificationRouter: () => NotificationRouterLike | undefined;
  loadPolpoConfig: (polpoDir: string) => any;
  savePolpoConfig: (polpoDir: string, config: any) => void;
}

// ── Auth deps ────────────────────────────────────────────────────────

export interface AuthRouteDeps {
  getConfig: () => any;
}

// ── File deps ────────────────────────────────────────────────────────

export interface FileRouteDeps {
  getPolpoDir: () => string;
  getWorkDir: () => string;
  getAgentWorkDir: () => string;
  emit: (event: string, data: any) => void;
}

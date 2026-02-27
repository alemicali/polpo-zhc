# @lumea-labs/polpo-react

Type-safe React hooks for OpenPolpo with real-time Server-Sent Events (SSE) updates.

## Features

- 🎣 **Modern React Hooks**: Built with `useSyncExternalStore` for optimal performance
- 📡 **Real-time Updates**: Push-based SSE, not polling
- 🔄 **Auto-reconnect**: Exponential backoff with event ID resumption
- 📦 **Zero Runtime Dependencies**: Only peer dependency is React
- 🎯 **Type-safe**: Full TypeScript support with inferred types
- ⚡ **Optimized**: Memoized selectors with WeakMap caching
- 🔌 **Request Deduplication**: Automatic concurrent request coalescing

## Installation

```bash
npm install @lumea-labs/polpo-react
```

**Peer Dependencies**:
- `react`: ^18.0.0 || ^19.0.0

## Quick Start

```tsx
import { PolpoProvider, useTasks, useAgents, useStats } from '@lumea-labs/polpo-react';

function App() {
  return (
    <PolpoProvider
      baseUrl="http://localhost:3890"
      apiKey="optional-api-key"
    >
      <Dashboard />
    </PolpoProvider>
  );
}

function Dashboard() {
  const { tasks } = useTasks();
  const agents = useAgents();
  const stats = useStats();

  return (
    <div>
      <h1>Polpo Dashboard</h1>
      <p>Tasks: {tasks.length}</p>
      <p>Pending: {stats?.pending ?? 0}</p>
      <ul>
        {tasks.map(task => (
          <li key={task.id}>
            {task.title} - {task.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## API Reference

### PolpoProvider

Root provider component that manages connection and state.

```tsx
<PolpoProvider
  baseUrl="http://localhost:3890"
  apiKey="optional-key"
  autoConnect={true}
>
  {children}
</PolpoProvider>
```

**Props**:
- `baseUrl`: OpenPolpo server URL
- `apiKey?`: Optional API key for authentication
- `autoConnect?`: Auto-connect on mount (default: true)
- `eventFilter?`: Array of SSE event type patterns to subscribe to

### Hooks

#### usePolpo()

Access full Polpo state and methods.

```tsx
const { client, connectionStatus } = usePolpo();

// connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

// Use the client to call API methods:
await client.createTask({ title: '...', description: '...', assignTo: 'backend-dev' });
await client.createMission({ data: '...', name: 'my-mission' });
```

#### useTasks(filter?)

Get all tasks with optional filtering.

```tsx
// All tasks
const { tasks } = useTasks();

// Filtered tasks
const { tasks: pendingTasks } = useTasks({ status: 'pending' });
const { tasks: agentTasks } = useTasks({ assignTo: 'backend-dev' });
```

**Returns**: `UseTasksReturn` (includes `tasks: Task[]`, `isLoading`, `error`, `createTask`, `deleteTask`, `retryTask`, `refetch`)

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  assignTo: string;
  status: 'draft' | 'pending' | 'awaiting_approval' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed';
  dependsOn: string[];
  group?: string;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
  expectations: TaskExpectation[];
  retries: number;
  maxRetries: number;
  missionGroup?: string;
}
```

#### useTask(taskId)

Get a single task by ID.

```tsx
const task = useTask('task-123');

if (!task) {
  return <div>Task not found</div>;
}

return <div>{task.title}: {task.status}</div>;
```

**Returns**: `Task | undefined`

#### useMissions()

Get all missions with CRUD and execution methods.

```tsx
const {
  missions,
  isLoading,
  error,
  createMission,
  updateMission,
  deleteMission,
  executeMission,
  resumeMission,
  abortMission,
  refetch,
} = useMissions();
```

**Returns**: `UseMissionsReturn`

```typescript
interface Mission {
  id: string;
  name: string;
  data: string;
  prompt?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  deadline?: string;
  schedule?: string;
  recurring?: boolean;
  qualityThreshold?: number;
  createdAt: string;
  updatedAt: string;
}
```

#### useMission(missionId)

Get a single mission by ID.

```tsx
const { mission, report, isLoading, executeMission, abortMission } = useMission('mission-123');
```

**Returns**: `UseMissionReturn` (includes `mission`, `report: MissionReport | undefined`, and action methods)

#### useAgents(filter?)

Get all agents.

```tsx
const agents = useAgents();
const availableAgents = useAgents({ available: true });
```

**Returns**: `AgentConfig[]`

```typescript
interface AgentConfig {
  name: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  maxConcurrency?: number;
  volatile?: boolean;
  missionGroup?: string;
}
```

#### useProcesses()

Get running agent processes.

```tsx
const processes = useProcesses();

return (
  <ul>
    {processes.map(proc => (
      <li key={proc.agentName}>
        {proc.agentName} - PID: {proc.pid} - {proc.alive ? 'Running' : 'Dead'}
      </li>
    ))}
  </ul>
);
```

**Returns**: `AgentProcess[]`

```typescript
interface AgentProcess {
  agentName: string;
  pid: number;
  taskId: string;
  startedAt: string;
  alive: boolean;
  activity: AgentActivity;
}

interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  filesCreated: string[];
  filesEdited: string[];
  toolCalls: number;
  totalTokens: number;
  lastUpdate: string;
  summary?: string;
  sessionId?: string;
}
```

#### useEvents(limit?)

Get recent events from the event stream.

```tsx
const events = useEvents(50); // Last 50 events

return (
  <ul>
    {events.map(event => (
      <li key={event.id}>
        {event.event}: {event.timestamp}
      </li>
    ))}
  </ul>
);
```

**Returns**: `SSEEvent[]`

#### useStats()

Get aggregate statistics.

```tsx
const stats = useStats();

if (!stats) return null;

return (
  <div>
    <p>Pending: {stats.pending}</p>
    <p>Running: {stats.running}</p>
    <p>Queued: {stats.queued}</p>
    <p>Done: {stats.done}</p>
    <p>Failed: {stats.failed}</p>
  </div>
);
```

**Returns**: `PolpoStats | null`

```typescript
interface PolpoStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  queued: number;
}
```

#### useMemory()

Get Polpo memory entries.

```tsx
const memory = useMemory();
```

**Returns**: `MemoryEntry[]`

#### useLogs(limit?)

Get recent log entries.

```tsx
const logs = useLogs(100);
```

**Returns**: `LogEntry[]`

### Methods

#### createTask(task)

Create a new task via the `useTasks` hook or directly via the client.

```tsx
const { createTask } = useTasks();

await createTask({
  title: 'Implement feature X',
  description: 'Add authentication to the API',
  assignTo: 'backend-dev',
});
```

#### retryTask(taskId)

Retry a failed task.

```tsx
const { retryTask } = useTasks();

await retryTask('task-123');
```

#### createMission(req)

Create a new mission.

```tsx
const { createMission } = useMissions();

await createMission({
  data: 'tasks:\n  - title: Task 1\n    assignTo: backend-dev\n    description: Do something',
  name: 'new-feature',
});
```

#### executeMission(missionId)

Execute a mission (create tasks and start agents).

```tsx
const { executeMission } = useMissions();

await executeMission('mission-123');
```

## Real-time Updates

The SDK uses Server-Sent Events (SSE) for push-based real-time updates. All hooks automatically update when the server emits events.

**Event Types**:
- `task:created`, `task:transition`, `task:updated`, `task:removed`, `task:retry`, `task:fix`, `task:timeout`
- `mission:saved`, `mission:executed`, `mission:completed`, `mission:resumed`, `mission:deleted`
- `agent:spawned`, `agent:finished`, `agent:activity`, `agent:stale`
- `assessment:started`, `assessment:progress`, `assessment:complete`, `assessment:corrected`
- `orchestrator:started`, `orchestrator:tick`, `orchestrator:shutdown`

**Auto-reconnect**:
- Exponential backoff (`reconnectDelay` → `maxReconnectDelay`, defaults 1s → 30s)
- Resumes from last event ID

## Authentication

The SDK supports two authentication methods:

**Header-based** (preferred):
```tsx
<PolpoProvider
  baseUrl="http://localhost:3890"
  apiKey="your-api-key"
>
```

**Query parameter** (for EventSource):
The SDK automatically appends `?apiKey=` to SSE requests when an API key is provided, since EventSource doesn't support custom headers.

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  Task,
  Mission,
  MissionReport,
  AgentConfig,
  AgentProcess,
  SSEEvent,
  PolpoStats,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
} from '@lumea-labs/polpo-react';
```

## Examples

### Task List with Retry

```tsx
import { useTasks } from '@lumea-labs/polpo-react';

function TaskList() {
  const { tasks, retryTask } = useTasks();

  return (
    <ul>
      {tasks.map(task => (
        <li key={task.id}>
          <span>{task.title} - {task.status}</span>
          {task.status === 'failed' && (
            <button onClick={() => retryTask(task.id)}>
              Retry
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
```

### Live Agent Activity

```tsx
import { useProcesses } from '@lumea-labs/polpo-react';

function AgentActivity() {
  const processes = useProcesses();

  return (
    <div>
      {processes.filter(p => p.alive).map(proc => (
        <div key={proc.agentName}>
          <h3>{proc.agentName}</h3>
          <p>Task: {proc.taskId}</p>
          {proc.activity && (
            <>
              <p>Tool: {proc.activity.lastTool}</p>
              <p>File: {proc.activity.lastFile}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
```

### Mission Progress

```tsx
import { useMission, useTasks } from '@lumea-labs/polpo-react';

function MissionProgress({ missionId }: { missionId: string }) {
  const { mission, report } = useMission(missionId);
  const { tasks } = useTasks({ group: missionId });

  if (!mission) return null;

  const completed = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div>
      <h2>{mission.name} ({mission.status})</h2>
      <progress value={completed} max={total} />
      <p>{progress.toFixed(0)}% complete ({completed}/{total})</p>
      {report && <p>Score: {report.avgScore?.toFixed(1) ?? 'N/A'}</p>}
    </div>
  );
}
```

### Event Stream

```tsx
import { useEvents } from '@lumea-labs/polpo-react';

function EventFeed() {
  const events = useEvents(20);

  return (
    <ul>
      {events.map(event => (
        <li key={event.id}>
          <strong>{event.event}</strong>
          {' - '}
          {new Date(event.timestamp).toLocaleTimeString()}
        </li>
      ))}
    </ul>
  );
}
```

## Performance

The SDK is optimized for performance:

- **Memoized Selectors**: WeakMap caching prevents unnecessary re-renders
- **Batched Updates**: `queueMicrotask` batching for event processing
- **Request Deduplication**: Concurrent identical requests are coalesced
- **Efficient Filtering**: Hooks support filtering without re-computation

## Bundle Size

- **Zero runtime dependencies** (only React peer)
- Tree-shakeable ESM exports
- `sideEffects: false` for optimal bundling

## License

MIT

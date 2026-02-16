# @openpolpo/react-sdk

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
npm install @openpolpo/react-sdk
```

**Peer Dependencies**:
- `react`: ^18.0.0 || ^19.0.0

## Quick Start

```tsx
import { PolpoProvider, useTasks, useAgents } from '@openpolpo/react-sdk';

function App() {
  return (
    <PolpoProvider
      baseURL="http://localhost:3890"
      projectId="my-project"
      apiKey="optional-api-key"
    >
      <Dashboard />
    </PolpoProvider>
  );
}

function Dashboard() {
  const tasks = useTasks();
  const agents = useAgents();
  const stats = useStats();

  return (
    <div>
      <h1>Polpo Dashboard</h1>
      <p>Tasks: {tasks.length}</p>
      <p>Active Agents: {stats.activeAgents}</p>
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
  baseURL="http://localhost:3890"
  projectId="my-project"
  apiKey="optional-key"
  autoConnect={true}
  reconnectInterval={1000}
  maxReconnectInterval={30000}
>
  {children}
</PolpoProvider>
```

**Props**:
- `baseURL`: OpenPolpo server URL
- `projectId`: Project identifier
- `apiKey?`: Optional API key for authentication
- `autoConnect?`: Auto-connect on mount (default: true)
- `reconnectInterval?`: Initial reconnect delay in ms (default: 1000)
- `maxReconnectInterval?`: Max reconnect delay in ms (default: 30000)

### Hooks

#### usePolpo()

Access full Polpo state and methods.

```tsx
const {
  // State
  tasks,
  plans,
  agents,
  processes,
  events,
  memory,
  logs,

  // Connection
  connected,
  connecting,

  // Methods
  createTask,
  updateTask,
  retryTask,
  createPlan,
  sendMessage,
  connect,
  disconnect,
} = usePolpo();
```

#### useTasks(filter?)

Get all tasks with optional filtering.

```tsx
// All tasks
const tasks = useTasks();

// Filtered tasks
const pendingTasks = useTasks({ status: 'pending' });
const agentTasks = useTasks({ agent: 'backend-dev' });
```

**Returns**: `Task[]`

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed';
  agent?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  dependencies?: string[];
  planGroup?: string;
  retryCount?: number;
  expectations?: Expectation[];
  assessmentResult?: AssessmentResult;
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

#### usePlans(filter?)

Get all plans with optional filtering.

```tsx
const plans = usePlans();
const activePlans = usePlans({ status: 'active' });
```

**Returns**: `Plan[]`

```typescript
interface Plan {
  group: string;
  tasks: string[];
  status: 'pending' | 'active' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
}
```

#### usePlan(planGroup)

Get a single plan by group name.

```tsx
const plan = usePlan('setup-project');
```

**Returns**: `Plan | undefined`

#### useAgents(filter?)

Get all agents.

```tsx
const agents = useAgents();
const availableAgents = useAgents({ available: true });
```

**Returns**: `Agent[]`

```typescript
interface Agent {
  name: string;
  description?: string;
  available: boolean;
  currentTask?: string;
  volatile?: boolean;
}
```

#### useProcesses()

Get running agent processes.

```tsx
const processes = useProcesses();

return (
  <ul>
    {processes.map(proc => (
      <li key={proc.agent}>
        {proc.agent} - PID: {proc.pid} - {proc.alive ? 'Running' : 'Dead'}
      </li>
    ))}
  </ul>
);
```

**Returns**: `AgentProcess[]`

```typescript
interface AgentProcess {
  agent: string;
  pid: number;
  sessionId?: string;
  taskId: string;
  startedAt: string;
  alive: boolean;
  lastActivity?: AgentActivity;
}

interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  lastUpdate: string;
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
        {event.type}: {event.timestamp}
      </li>
    ))}
  </ul>
);
```

**Returns**: `PolpoEvent[]`

#### useStats()

Get aggregate statistics.

```tsx
const stats = useStats();

return (
  <div>
    <p>Total Tasks: {stats.totalTasks}</p>
    <p>Completed: {stats.completedTasks}</p>
    <p>Failed: {stats.failedTasks}</p>
    <p>Active Agents: {stats.activeAgents}</p>
  </div>
);
```

**Returns**: `Stats`

```typescript
interface Stats {
  totalTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeAgents: number;
  totalPlans: number;
  activePlans: number;
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

Create a new task.

```tsx
const { createTask } = usePolpo();

await createTask({
  title: 'Implement feature X',
  description: 'Add authentication to the API',
  agent: 'backend-dev',
});
```

#### updateTask(taskId, updates)

Update an existing task.

```tsx
const { updateTask } = usePolpo();

await updateTask('task-123', {
  status: 'done',
  result: 'Feature implemented successfully',
});
```

#### retryTask(taskId)

Retry a failed task.

```tsx
const { retryTask } = usePolpo();

await retryTask('task-123');
```

#### createPlan(yaml)

Create a new plan from YAML.

```tsx
const { createPlan } = usePolpo();

const yaml = `
group: new-feature
tasks:
  - title: Task 1
    agent: backend-dev
    description: Do something
`;

await createPlan(yaml);
```

#### sendMessage(content, metadata?)

Send a message through the chat interface.

```tsx
const { sendMessage } = usePolpo();

await sendMessage('Create a new task for implementing auth', {
  targetAgent: 'backend-dev',
});
```

## Real-time Updates

The SDK uses Server-Sent Events (SSE) for push-based real-time updates. All hooks automatically update when the server emits events.

**Event Types**:
- `task:created`, `task:updated`, `task:assigned`, `task:completed`, `task:failed`
- `plan:created`, `plan:started`, `plan:completed`
- `agent:registered`, `agent:assigned`, `agent:available`
- `process:started`, `process:stopped`, `process:activity`
- `system:*` events

**Auto-reconnect**:
- Exponential backoff (1s → 30s)
- Resumes from last event ID
- Circular buffer (1000 events) for reconnection

## Authentication

The SDK supports two authentication methods:

**Header-based** (preferred):
```tsx
<PolpoProvider
  baseURL="http://localhost:3890"
  projectId="my-project"
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
  Plan,
  Agent,
  AgentProcess,
  PolpoEvent,
  Stats,
  CreateTaskInput,
  UpdateTaskInput,
} from '@openpolpo/react-sdk';
```

## Examples

### Task List with Retry

```tsx
import { useTasks, usePolpo } from '@openpolpo/react-sdk';

function TaskList() {
  const tasks = useTasks();
  const { retryTask } = usePolpo();

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
import { useProcesses } from '@openpolpo/react-sdk';

function AgentActivity() {
  const processes = useProcesses();

  return (
    <div>
      {processes.filter(p => p.alive).map(proc => (
        <div key={proc.agent}>
          <h3>{proc.agent}</h3>
          <p>Task: {proc.taskId}</p>
          {proc.lastActivity && (
            <>
              <p>Tool: {proc.lastActivity.lastTool}</p>
              <p>File: {proc.lastActivity.lastFile}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
```

### Plan Progress

```tsx
import { usePlan, useTasks } from '@openpolpo/react-sdk';

function PlanProgress({ planGroup }: { planGroup: string }) {
  const plan = usePlan(planGroup);
  const allTasks = useTasks();

  if (!plan) return null;

  const planTasks = allTasks.filter(t => plan.tasks.includes(t.id));
  const completed = planTasks.filter(t => t.status === 'done').length;
  const total = planTasks.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div>
      <h2>{planGroup}</h2>
      <progress value={completed} max={total} />
      <p>{progress.toFixed(0)}% complete ({completed}/{total})</p>
    </div>
  );
}
```

### Event Stream

```tsx
import { useEvents } from '@openpolpo/react-sdk';

function EventFeed() {
  const events = useEvents(20);

  return (
    <ul>
      {events.map(event => (
        <li key={event.id}>
          <strong>{event.type}</strong>
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

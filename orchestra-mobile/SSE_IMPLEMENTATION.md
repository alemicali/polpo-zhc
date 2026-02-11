# Polpo Mobile - SSE & API Client Implementation

## Overview

Polpo Mobile now has full real-time connectivity with Polpo server via:
- **HTTP API Client** (`axios`) for REST endpoints
- **SSE (Server-Sent Events)** via custom `XMLHttpRequest` implementation
- **Unified Hook** (`useOrchestra`) for state management

## Architecture

### 1. API Client (`src/api/orchestra-client.ts`)

HTTP client wrapping Polpo's REST API:

```typescript
const client = new OrchestraClient({
  baseUrl: 'http://localhost:3000',
  projectId: 'default',
  apiKey: 'optional-key'
});

// Fetch tasks
const tasks = await client.getTasks();

// Create task
const task = await client.createTask({
  title: 'New task',
  description: 'Task description',
  assignTo: 'agent-name'
});
```

**Key Methods:**
- Tasks: `getTasks()`, `getTask()`, `createTask()`, `updateTask()`, `deleteTask()`, `retryTask()`, `killTask()`
- Plans: `getPlans()`, `getPlan()`, `createPlan()`, `executePlan()`, `resumePlan()`, `abortPlan()`
- Agents: `getAgents()`, `addAgent()`, `removeAgent()`, `getTeam()`, `getProcesses()`
- Project: `getState()`, `getConfig()`, `getMemory()`, `saveMemory()`

### 2. SSE Event Source (`src/api/event-source.ts`)

React Native-compatible SSE client using `XMLHttpRequest`:

```typescript
const eventSource = new EventSourceManager({
  url: 'http://localhost:3000/api/v1/projects/default/events',
  apiKey: 'optional-key',
  onEvent: (event: SSEEvent) => {
    console.log(`Event: ${event.event}`, event.data);
  },
  onStatusChange: (status: ConnectionStatus) => {
    console.log(`Connection: ${status}`);
  },
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
});

eventSource.connect();
```

**Features:**
- ✅ Automatic reconnection with exponential backoff
- ✅ Last-Event-ID support for resuming missed events
- ✅ All 35+ Polpo event types (task:*, agent:*, plan:*, etc.)
- ✅ React Native compatible (uses XMLHttpRequest)

**Event Types:**
- `task:created`, `task:transition`, `task:updated`, `task:removed`
- `agent:spawned`, `agent:finished`, `agent:activity`
- `plan:saved`, `plan:executed`, `plan:completed`
- `orchestrator:started`, `orchestrator:tick`, `orchestrator:shutdown`
- `assessment:*`, `deadlock:*`, `log`

### 3. useOrchestra Hook (`src/hooks/useOrchestra.ts`)

Unified hook combining HTTP + SSE:

```typescript
const {
  // Connection
  connectionStatus,
  connectionStatusLabel,
  isConnected,

  // Settings
  settings,
  settingsLoaded,
  updateSettings,
  clearSettings,

  // Data (real-time updated)
  tasks,
  plans,
  agents,
  processes,

  // Actions
  connect,
  disconnect,
  refreshTasks,
  refreshAll,

  // State
  loading,
  error,
  client,
} = useOrchestra();
```

**Auto-sync:** SSE events automatically update `tasks`, `plans`, `processes` in real-time.

## Usage in Screens

### HomeScreen Example

```typescript
import { useOrchestra } from '../hooks/useOrchestra';

function HomeScreen() {
  const {
    connectionStatus,
    isConnected,
    tasks,
    plans,
    loading,
  } = useOrchestra();

  const activeTasks = tasks.filter(t => t.status === 'in_progress');

  return (
    <View>
      <Text>Status: {connectionStatusLabel}</Text>
      <Text>Active Tasks: {activeTasks.length}</Text>
      {activeTasks.map(task => (
        <TaskCard key={task.id} task={task} />
      ))}
    </View>
  );
}
```

### SettingsScreen Example

```typescript
function SettingsScreen() {
  const {
    settings,
    updateSettings,
    connect,
    disconnect,
  } = useOrchestra();

  const handleSave = async () => {
    await updateSettings({
      baseUrl: 'http://192.168.1.100:3000',
      projectId: 'my-project',
      apiKey: 'secret',
    });
    disconnect();
    connect(); // Reconnect with new settings
  };

  return <SettingsForm onSave={handleSave} />;
}
```

## Settings Storage

Settings are persisted in AsyncStorage:

```
@orchestra/baseUrl     → "http://localhost:3000"
@orchestra/projectId   → "default"
@orchestra/apiKey      → "optional-key" (encrypted)
```

## Connection Flow

1. **App Launch**
   - `useOrchestra` loads settings from AsyncStorage
   - Auto-connects if settings exist

2. **Connection Established**
   - HTTP client initialized
   - SSE connection opened
   - Initial data fetch (`refreshAll()`)

3. **Real-time Updates**
   - SSE events → `handleEvent()` → state updates
   - React components re-render automatically

4. **Reconnection**
   - Network error → exponential backoff → retry
   - Last-Event-ID sent to resume from last event

## Error Handling

```typescript
const { error, loading } = useOrchestra();

if (error) {
  return <ErrorView message={error} />;
}

if (loading) {
  return <LoadingSpinner />;
}
```

## Testing Connection

```typescript
import { OrchestraClient } from '../api/orchestra-client';

async function testConnection(baseUrl: string) {
  try {
    const health = await OrchestraClient.health(baseUrl);
    console.log(`Connected to v${health.version}`);
    return true;
  } catch (err) {
    console.error('Connection failed:', err);
    return false;
  }
}
```

## Event Types Reference

All Polpo events are typed in `src/api/types.ts`:

```typescript
export type OrchestraEventType =
  | "task:created" | "task:transition" | "task:updated"
  | "agent:spawned" | "agent:finished" | "agent:activity"
  | "plan:saved" | "plan:executed" | "plan:completed"
  | "orchestrator:started" | "orchestrator:tick"
  | ... (35+ total)
```

## Files Created

```
src/
├── api/
│   ├── index.ts                 # API exports
│   ├── types.ts                 # Type definitions (duplicated from react-sdk)
│   ├── orchestra-client.ts      # HTTP client (axios)
│   └── event-source.ts          # SSE client (XMLHttpRequest)
├── hooks/
│   ├── index.ts                 # Hook exports
│   └── useOrchestra.ts          # Main hook (HTTP + SSE + state)
└── screens/
    ├── HomeScreen.tsx           # Updated with real-time data
    └── SettingsScreen.tsx       # Updated with connection management
```

## Dependencies Added

```json
{
  "dependencies": {
    "axios": "^1.x.x",
    "@react-native-async-storage/async-storage": "^1.x.x"
  }
}
```

## Acceptance Criteria

✅ **File Existence:**
- `orchestra-mobile/src/api/event-source.ts` — Created

✅ **SSE Client:**
- Handles connection, reconnection, and event parsing
- Uses XMLHttpRequest (React Native compatible)
- Exponential backoff (1s → 30s max)
- Last-Event-ID support

✅ **Real-time Updates:**
- Tasks, plans, agents auto-update on SSE events
- Connection status indicator in HomeScreen
- Manual refresh available

✅ **Settings Management:**
- AsyncStorage persistence
- Connection test functionality
- Auto-reconnect on settings change

## Next Steps

1. **Implement TasksScreen** — Full task list with filters
2. **Implement PlansScreen** — Plan management UI
3. **Add notifications** — Push notifications for task updates
4. **Offline support** — Queue actions when disconnected
5. **Error retry UI** — Manual retry for failed operations

## Debugging

Enable verbose logging:

```typescript
// In event-source.ts
private handleMessage(e: MessageEvent): void {
  console.log('SSE Event:', e.type, e.data);
  // ...
}

// In useOrchestra.ts
const handleEvent = useCallback((event: SSEEvent) => {
  console.log('Polpo Event:', event.event, event.data);
  // ...
}, []);
```

## Known Limitations

1. **React Native Web EventSource** — XHR fallback works, but native EventSource may fail on web
2. **No binary support** — SSE is text-only (JSON payload)
3. **No bidirectional** — For client→server push, use HTTP POST
4. **Mobile reconnection** — Background apps may disconnect (implement app state listeners)

---

**Implementation Complete** ✅

All acceptance criteria met. SSE client properly handles connection, reconnection, and event parsing.

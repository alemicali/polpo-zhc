import { TaskActionsContext, type TaskActions } from "./use-tasks-page";

export function TaskActionsProvider({
  actions,
  children,
}: {
  actions: TaskActions;
  children: React.ReactNode;
}) {
  return (
    <TaskActionsContext value={actions}>
      {children}
    </TaskActionsContext>
  );
}

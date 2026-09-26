import type {
  ToolExecutionEvent,
  ToolExecutionObserver,
} from "../agent/tool-events.js";

type Spinner = {
  message(message?: string): void;
};

/** Keeps the terminal spinner useful while the agent moves between tools. */
export function createToolActivityReporter(
  activity: Spinner,
): ToolExecutionObserver {
  const active = new Map<string, number>();
  const completed: string[] = [];
  const failed: string[] = [];

  const update = () => {
    const history = formatHistory(completed, failed);
    if (active.size) {
      const current = formatToolHistory(
        [...active].flatMap(([toolName, count]) =>
          Array.from({ length: count }, () => toolName),
        ),
      );
      activity.message(
        history ? `Working: ${current} · ${history}` : `Working: ${current}`,
      );
      return;
    }

    activity.message(
      history ? `Preparing response · ${history}` : "Working on your request",
    );
  };

  return (event: ToolExecutionEvent) => {
    if (event.type === "started") {
      const { toolName } = event;
      active.set(toolName, (active.get(toolName) ?? 0) + 1);
      update();
      return;
    }

    const { toolName, succeeded } = event;
    const count = active.get(toolName) ?? 0;
    if (count <= 1) active.delete(toolName);
    else active.set(toolName, count - 1);
    (succeeded ? completed : failed).push(toolName);
    update();
  };
}

function formatHistory(completed: string[], failed: string[]): string {
  return [
    completed.length && `Completed: ${formatToolHistory(completed)}`,
    failed.length && `Failed: ${formatToolHistory(failed)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatToolHistory(toolNames: string[]): string {
  const counts = new Map<string, number>();
  for (const toolName of toolNames)
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1);

  return [...counts]
    .map(([name, count]) => (count === 1 ? name : `${name} × ${count}`))
    .join(", ");
}

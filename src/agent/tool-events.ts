export type ToolExecutionEvent =
  | { type: "started"; toolName: string }
  | { type: "finished"; toolName: string; succeeded: boolean };

export type ToolExecutionObserver = (event: ToolExecutionEvent) => void;

type ExecutableTool = {
  execute?: (...args: any[]) => unknown;
};

/**
 * Adds best-effort lifecycle events without changing individual tool
 * definitions or allowing an observer failure to interrupt tool execution.
 */
export function instrumentToolExecutions<
  TOOLS extends Record<string, ExecutableTool>,
>(tools: TOOLS, onToolExecution?: ToolExecutionObserver): TOOLS {
  if (!onToolExecution) return tools;

  return Object.fromEntries(
    Object.entries(tools).map(([toolName, tool]) => {
      if (!tool.execute) return [toolName, tool];

      const execute = tool.execute;
      return [
        toolName,
        {
          ...tool,
          execute: async (...args: any[]) => {
            notify(onToolExecution, { type: "started", toolName });
            try {
              const result = await execute(...args);
              notify(onToolExecution, {
                type: "finished",
                toolName,
                succeeded: true,
              });
              return result;
            } catch (error) {
              notify(onToolExecution, {
                type: "finished",
                toolName,
                succeeded: false,
              });
              throw error;
            }
          },
        },
      ];
    }),
  ) as TOOLS;
}

function notify(
  observer: ToolExecutionObserver,
  event: ToolExecutionEvent,
): void {
  try {
    observer(event);
  } catch {
    // Terminal/reporting failures must not change the agent result.
  }
}

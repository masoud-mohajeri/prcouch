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
  const executions = new Map<string, Promise<unknown>>();

  return Object.fromEntries(
    Object.entries(tools).map(([toolName, tool]) => {
      if (!tool.execute) return [toolName, tool];

      const execute = tool.execute;
      return [
        toolName,
        {
          ...tool,
          execute: async (...args: any[]) => {
            const cacheKey = `${toolName}:${JSON.stringify(args[0] ?? null)}`;
            const existing = executions.get(cacheKey);
            if (existing) return existing;

            const execution = executeTool(
              toolName,
              execute,
              args,
              onToolExecution,
            );
            executions.set(cacheKey, execution);
            try {
              return await execution;
            } catch (error) {
              // Retain successful output for this whole agent turn, but allow
              // a failed operation to be retried if the model corrects itself.
              executions.delete(cacheKey);
              throw error;
            }
          },
        },
      ];
    }),
  ) as TOOLS;
}

async function executeTool(
  toolName: string,
  execute: (...args: any[]) => unknown,
  args: any[],
  onToolExecution?: ToolExecutionObserver,
): Promise<unknown> {
  if (!onToolExecution) return execute(...args);
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

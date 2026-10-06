export type ToolExecutionEvent =
  | { type: "started"; toolName: string; input?: unknown }
  | {
      type: "finished";
      toolName: string;
      succeeded: boolean;
      summary?: { returned: number; total?: number; status?: string };
    };

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
  const diagnostic =
    toolName === "list_analyzed_comments" ||
    toolName === "get_analyzed_comment";
  notify(onToolExecution, {
    type: "started",
    toolName,
    ...(diagnostic ? { input: args[0] } : {}),
  });
  try {
    const result = await execute(...args);
    notify(onToolExecution, {
      type: "finished",
      toolName,
      succeeded: true,
      ...(diagnostic ? { summary: summarizeCommentLookup(result) } : {}),
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

function summarizeCommentLookup(result: unknown) {
  if (!result || typeof result !== "object") return { returned: 0 };
  const data = result as {
    records?: unknown[];
    record?: unknown;
    total?: number;
    status?: string;
  };
  return {
    returned: Array.isArray(data.records)
      ? data.records.length
      : data.record
        ? 1
        : 0,
    ...(typeof data.total === "number" ? { total: data.total } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
  };
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

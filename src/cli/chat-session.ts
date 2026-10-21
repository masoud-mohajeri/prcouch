import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { ModelMessage } from "ai";
import { setActiveTraceIO, startActiveObservation } from "@langfuse/tracing";

import { runGitLabAgent, isWebResearchRequest } from "../agent/agent.js";
import { getResearchBatchRequest } from "../research/requests.js";
import {
  GitLabClient,
  requireGitLabConnectionConfig,
} from "../gitlab/client.js";
import { formatCliError } from "./error.js";
import { createCategorizationProgressReporter } from "./categorization-progress.js";
import { createResearchProgressReporter } from "./research-progress.js";
import { writeCliLog } from "./logging.js";
import { createToolActivityReporter } from "./tool-activity.js";
import { flushCliTracing } from "./tracing.js";

export type ChatSessionOptions = {
  initialInput: string;
  terminalUi: boolean;
};

/** Runs one noninteractive request or an in-memory interactive chat session. */
export async function runChatSession({
  initialInput,
  terminalUi,
}: ChatSessionOptions): Promise<void> {
  if (terminalUi) intro("GitLab review analysis");

  let gitLabClient: GitLabClient | undefined;
  try {
    gitLabClient = await selectGitLabProject(terminalUi);
  } catch (error) {
    showError(formatCliError(error), terminalUi);
    if (!terminalUi) process.exitCode = 1;
    if (terminalUi) outro("Chat ended.");
    return;
  }
  if (!gitLabClient) {
    if (terminalUi) outro("Chat ended.");
    return;
  }

  const chatHistory: ModelMessage[] = [];
  let input = initialInput || (await getInput());

  while (input) {
    if (!(await runTurn(input, chatHistory, terminalUi, gitLabClient))) break;

    // A piped command remains a single request. Interactive sessions stay open
    // until the user cancels the prompt, retaining only this process's history.
    input = terminalUi ? await getInput() : undefined;
  }

  if (terminalUi) outro("Chat ended.");
}

async function runTurn(
  input: string,
  chatHistory: ModelMessage[],
  terminalUi: boolean,
  gitLabClient: GitLabClient,
): Promise<boolean> {
  const activity = terminalUi ? spinner() : undefined;
  const reportActivity = activity
    ? createToolActivityReporter(activity)
    : undefined;
  const lookupDiagnostics: string[] = [];
  const controller = new AbortController();
  const interruptResearch = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminateResearch = () => {
    process.exitCode = 143;
    controller.abort();
  };
  let handlesResearchSignals = false;
  let researchRunId: string | undefined;
  const reportResearch = createResearchProgressReporter(activity);
  try {
    handlesResearchSignals = Boolean(
      getResearchBatchRequest(input, isWebResearchRequest(input, chatHistory)),
    );
    if (handlesResearchSignals) {
      process.on("SIGINT", interruptResearch);
      process.on("SIGTERM", terminateResearch);
    }
    activity?.start("Working on your request");
    const result = await startActiveObservation(
      "gitlab-agent-turn",
      async (observation) => {
        observation.update({ input });
        const output = await runGitLabAgent(input, {
          gitLabClient,
          chatHistory,
          onToolExecution: (event) => {
            reportActivity?.(event);
            if (event.type === "started" && event.input)
              lookupDiagnostics.push(
                `${event.toolName} ${JSON.stringify(event.input)}`,
              );
            if (event.type === "finished" && event.summary) {
              const { returned, total, status } = event.summary;
              lookupDiagnostics.push(
                `${event.toolName}: returned ${returned}${total === undefined ? "" : ` of ${total} matching analyses`}${status ? ` (${status})` : ""}`,
              );
            }
          },
          onCategorizationProgress: activity
            ? createCategorizationProgressReporter(activity)
            : undefined,
          signal: controller.signal,
          onResearchProgress: (event) => {
            researchRunId = event.runId;
            reportResearch(event);
          },
        });
        observation.update({ output });
        setActiveTraceIO({ input, output });
        return output;
      },
      { asType: "agent" },
    );
    activity?.stop("Request complete");

    console.log(terminalUi ? `\nResponse\n\n${result.text}` : result.text);
    if (result.toolCalls.length)
      console.log(`\nTools used: ${formatToolCalls(result.toolCalls)}`);
  } catch (error) {
    activity?.stop("Request failed", 1);
    showError(formatCliError(error), terminalUi);
    if (researchRunId)
      console.log(
        `Research run ${researchRunId}. Resume with: Resume research run ${researchRunId}`,
      );
    if (!terminalUi && !controller.signal.aborted) process.exitCode = 1;
  } finally {
    if (handlesResearchSignals) {
      process.off("SIGINT", interruptResearch);
      process.off("SIGTERM", terminateResearch);
    }
    if (lookupDiagnostics.length)
      console.log(`\nDatabase lookups:\n${lookupDiagnostics.join("\n")}`);
    try {
      await flushCliTracing();
    } catch (error) {
      writeCliLog(
        "warning",
        `Could not flush Langfuse tracing: ${String(error)}`,
        terminalUi,
      );
    }
  }
  return !controller.signal.aborted;
}

async function selectGitLabProject(
  terminalUi: boolean,
): Promise<GitLabClient | undefined> {
  if (!terminalUi) {
    throw new Error(
      "GitLab project selection requires an interactive terminal. Run npm start without redirecting stdin or stdout.",
    );
  }

  const connection = requireGitLabConnectionConfig();
  const activity = spinner();
  try {
    activity.start("Loading your GitLab projects");
    const projects = await new GitLabClient({
      ...connection,
      project: "",
    }).listProjects();
    activity.stop("GitLab projects loaded");

    if (!projects.length) {
      writeCliLog(
        "error",
        "No GitLab projects are available to this token.",
        terminalUi,
      );
      return undefined;
    }

    const selectedId = await select({
      message: "Which GitLab project would you like to analyze?",
      options: projects.map((project) => ({
        value: String(project.id),
        label: project.path_with_namespace,
        hint: project.name,
      })),
    });

    if (isCancel(selectedId)) {
      cancel("Project selection cancelled.");
      return undefined;
    }

    const project = projects.find((item) => String(item.id) === selectedId);
    if (!project) {
      throw new Error("The selected GitLab project was not found.");
    }

    return new GitLabClient({ ...connection, project: String(project.id) });
  } catch (error) {
    activity.stop("Could not load GitLab projects", 1);
    throw error;
  }
}

async function getInput(): Promise<string | undefined> {
  const response = await text({
    message: "What would you like to do?",
    placeholder: "List unresolved review comments in recent merge requests",
    validate: (value) =>
      value.trim() ? undefined : "Enter a request to continue.",
  });

  if (isCancel(response)) {
    cancel("Request cancelled.");
    return undefined;
  }

  return response.trim();
}

function showError(message: string, terminalUi: boolean): void {
  writeCliLog("error", message, terminalUi);
}

function formatToolCalls(toolCalls: string[]): string {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls)
    counts.set(toolCall, (counts.get(toolCall) ?? 0) + 1);

  return [...counts]
    .map(([name, count]) => (count === 1 ? name : `${name} × ${count}`))
    .join(", ");
}

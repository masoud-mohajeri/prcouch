import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { ModelMessage } from "ai";

import { runGitLabAgent } from "../agent/agent.js";
import {
  GitLabClient,
  requireGitLabConnectionConfig,
} from "../gitlab/client.js";
import { formatCliError } from "./error.js";
import { createCategorizationProgressReporter } from "./categorization-progress.js";
import { createToolActivityReporter } from "./tool-activity.js";

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
    await runTurn(input, chatHistory, terminalUi, gitLabClient);

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
): Promise<void> {
  const activity = terminalUi ? spinner() : undefined;
  try {
    activity?.start("Working on your request");
    const result = await runGitLabAgent(input, {
      gitLabClient,
      chatHistory,
      onToolExecution: activity
        ? createToolActivityReporter(activity)
        : undefined,
      onCategorizationProgress: activity
        ? createCategorizationProgressReporter(activity)
        : undefined,
    });
    activity?.stop("Request complete");

    console.log(terminalUi ? `\nResponse\n\n${result.text}` : result.text);
    if (result.toolCalls.length)
      console.log(`\nTools used: ${formatToolCalls(result.toolCalls)}`);
  } catch (error) {
    activity?.stop("Request failed", 1);
    showError(formatCliError(error), terminalUi);
    if (!terminalUi) process.exitCode = 1;
  }
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
      log.error("No GitLab projects are available to this token.");
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
  if (terminalUi) {
    log.error(message);
  } else {
    console.error(message);
  }
}

function formatToolCalls(toolCalls: string[]): string {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls)
    counts.set(toolCall, (counts.get(toolCall) ?? 0) + 1);

  return [...counts]
    .map(([name, count]) => (count === 1 ? name : `${name} × ${count}`))
    .join(", ");
}

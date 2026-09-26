import "dotenv/config";

import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  spinner,
  text,
} from "@clack/prompts";

import { runGitLabAgent } from "./agent.js";
import { formatCliError } from "./cli-error.js";

const terminalUi = Boolean(process.stdin.isTTY && process.stdout.isTTY);

if (!process.env.OPENAI_API_KEY) {
  showError(
    "OPENAI_API_KEY is required. Copy .env.example to .env and add it.",
  );
  process.exit(1);
}

if (terminalUi) intro("GitLab review analysis");
const input = await getInput();

const activity = terminalUi ? spinner() : undefined;
try {
  activity?.start("Working on your request");
  const result = await runGitLabAgent(input);
  activity?.stop("Request complete");

  if (terminalUi) {
    console.log(`\nResponse\n\n${result.text}`);
    if (result.toolCalls.length)
      console.log(`\nTools used: ${formatToolCalls(result.toolCalls)}`);
    outro("Done");
  } else {
    console.log(result.text);
    if (result.toolCalls.length)
      console.log(`\nTools used: ${formatToolCalls(result.toolCalls)}`);
  }
} catch (error) {
  activity?.stop("Request failed", 1);
  showError(formatCliError(error));
  process.exitCode = 1;
}

async function getInput(): Promise<string> {
  const argumentInput = process.argv.slice(2).join(" ").trim();
  if (argumentInput) return argumentInput;

  if (!terminalUi) {
    console.error('Usage: npm start -- "List unresolved review comments"');
    process.exit(1);
  }

  const response = await text({
    message: "What would you like to do?",
    placeholder: "List unresolved review comments in recent merge requests",
    validate: (value) =>
      value.trim() ? undefined : "Enter a request to continue.",
  });

  if (isCancel(response)) {
    cancel("Request cancelled.");
    process.exit(0);
  }

  return response.trim();
}

function showError(message: string): void {
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

import "dotenv/config";

import { runTaskAgent } from "./agent.js";
import { formatCliError } from "./cli-error.js";
import { TaskStore } from "./task-store.js";

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error('Usage: npm start -- "Add buy milk tomorrow"');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required. Copy .env.example to .env and add it.");
  process.exit(1);
}

try {
  const result = await runTaskAgent(input, new TaskStore());
  console.log(result.text);
  if (result.toolCalls.length) console.log(`\nTools used: ${result.toolCalls.join(", ")}`);
} catch (error) {
  console.error(formatCliError(error));
  process.exitCode = 1;
}

import "dotenv/config";

import { runChatSession } from "./chat-session.js";
import { installProcessWarningLogger, writeCliLog } from "./logging.js";

const terminalUi = Boolean(process.stdin.isTTY && process.stdout.isTTY);
installProcessWarningLogger(terminalUi);

if (!process.env.OPENAI_API_KEY) {
  showError(
    "OPENAI_API_KEY is required. Copy .env.example to .env and add it.",
  );
  process.exit(1);
}

const argumentInput = process.argv.slice(2).join(" ").trim();
if (!terminalUi && !argumentInput) {
  console.error('Usage: npm start -- "List unresolved review comments"');
  process.exit(1);
}

await runChatSession({ initialInput: argumentInput, terminalUi });

function showError(message: string): void {
  writeCliLog("error", message, terminalUi);
}

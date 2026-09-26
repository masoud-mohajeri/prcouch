import "dotenv/config";

import { evaluate } from "@lmnr-ai/lmnr";

import { cases } from "./cases.js";
import { executeEvalCase } from "./executor.js";
import { evaluators } from "./scorers.js";

const projectApiKey = required("LMNR_PROJECT_API_KEY");
const baseUrl = process.env.LMNR_BASE_URL?.trim() || "http://localhost";
if (new URL(baseUrl).port) {
  throw new Error(
    "LMNR_BASE_URL must be only the scheme and host; set ports with LMNR_HTTP_PORT and LMNR_GRPC_PORT.",
  );
}

const result = await evaluate({
  name: "gitlab-agent-golden",
  groupName: "gitlab-agent",
  data: cases,
  executor: executeEvalCase,
  evaluators,
  config: {
    projectApiKey,
    baseUrl,
    httpPort: port("LMNR_HTTP_PORT", 8000),
    grpcPort: port("LMNR_GRPC_PORT", 8001),
    frontendPort: port("LMNR_FRONTEND_PORT", 5667),
    concurrencyLimit: 1,
  },
});

if (!result) throw new Error("Laminar did not return an evaluation result.");
console.log(`Laminar evaluation completed: ${result.url}`);
console.log(`Average scores: ${JSON.stringify(result.averageScores)}`);

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}.`);
  return value;
}

function port(name: string, fallback: number) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return parsed;
}

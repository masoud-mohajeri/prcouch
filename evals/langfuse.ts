import "dotenv/config";

import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setActiveTraceIO, startActiveObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { cases, type EvalInput, type EvalTarget } from "./cases.js";
import { executeEvalCase } from "./executor.js";
import { langfuseEvaluators } from "./scorers.js";

const publicKey = required("LANGFUSE_PUBLIC_KEY");
const secretKey = required("LANGFUSE_SECRET_KEY");
const baseUrl = optionalUrl("LANGFUSE_BASE_URL");
const langfuseOptions = { publicKey, secretKey, ...(baseUrl && { baseUrl }) };
const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor(langfuseOptions)],
});
const langfuse = new LangfuseClient(langfuseOptions);

otelSdk.start();

try {
  const result = await langfuse.experiment.run<EvalInput, EvalTarget>({
    name: "gitlab-agent-golden",
    description: "Golden checks for GitLab review-comment retrieval.",
    data: cases.map(({ data, target, metadata }) => ({
      input: data,
      expectedOutput: target,
      metadata,
    })),
    // This experiment supplies only the local data declared above; Langfuse's
    // task type also supports remote dataset items whose input is unknown.
    task: ({ input }) => {
      const evalInput = input as EvalInput;
      return startActiveObservation(
        "gitlab-agent-eval",
        async (observation) => {
          observation.update({
            input: evalInput,
            metadata: { fixture: evalInput.gitLabFixture },
          });
          const output = await executeEvalCase(evalInput);
          observation.update({ output });
          setActiveTraceIO({ input: evalInput, output });
          return output;
        },
        { asType: "agent" },
      );
    },
    evaluators: langfuseEvaluators,
    maxConcurrency: 1,
  });

  console.log(await result.format({ includeItemResults: true }));
} finally {
  await langfuse.flush();
  await otelSdk.shutdown();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}.`);
  return value;
}

function optionalUrl(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

import type { Evaluator } from "@langfuse/client";

import type { EvalInput, EvalTarget } from "./cases.js";
import type { EvalOutput } from "./executor.js";

/** Named, deterministic scorers shared by the local runner and Langfuse. */
export const evaluators = {
  toolSequence: (output: EvalOutput, target?: EvalTarget) =>
    Number(Boolean(target && sameArray(output.toolCalls, target.toolSequence))),
  gitLabRequests: (output: EvalOutput, target?: EvalTarget) =>
    Number(
      Boolean(
        target &&
        (!target.gitLabRequests ||
          sameArray(output.gitLabRequests, target.gitLabRequests)),
      ),
    ),
  answerCoverage: (output: EvalOutput, target?: EvalTarget) => {
    const answer = output.text.toLowerCase();
    return Number(
      Boolean(
        target &&
        target.answerIncludes.every((phrase) => answer.includes(phrase)),
      ),
    );
  },
};

export const langfuseEvaluators: Evaluator<EvalInput, EvalTarget>[] = [
  async ({ output, expectedOutput }) => ({
    name: "toolSequence",
    value: evaluators.toolSequence(output as EvalOutput, expectedOutput),
  }),
  async ({ output, expectedOutput }) => ({
    name: "gitLabRequests",
    value: evaluators.gitLabRequests(output as EvalOutput, expectedOutput),
  }),
  async ({ output, expectedOutput }) => ({
    name: "answerCoverage",
    value: evaluators.answerCoverage(output as EvalOutput, expectedOutput),
  }),
];

export function score(output: EvalOutput, target: EvalTarget) {
  return Object.fromEntries(
    Object.entries(evaluators).map(([name, evaluator]) => [
      name,
      evaluator(output, target),
    ]),
  );
}

function sameArray(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index])
  );
}

import "dotenv/config";

import { cases } from "./cases.js";
import { executeEvalCase } from "./executor.js";
import { score } from "./scorers.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required to run live evals.");
}

let failures = 0;
for (const testCase of cases) {
  const output = await executeEvalCase(testCase.data);
  const scores = score(output, testCase.target);
  const passed = Object.values(scores).every((value) => value === 1);
  console.log(`${passed ? "PASS" : "FAIL"} ${testCase.metadata.name}`);
  if (!passed) {
    failures += 1;
    for (const [name, value] of Object.entries(scores)) {
      if (!value) console.log(`  Failed scorer: ${name}`);
    }
  }
}

if (failures) process.exit(1);

import type { ResearchBatchProgressEvent } from "../research/service.js";

/** Update the spinner, or emit at most ten progress increments for plain output. */
export function createResearchProgressReporter(
  activity?: { message(message?: string): void },
  write: (message: string) => void = (message) =>
    process.stderr.write(`${message}\n`),
) {
  let lastBucket = -1;
  return (event: ResearchBatchProgressEvent): void => {
    const { total, completed, failed, remaining } = event.counts;
    const finished = completed + failed;
    const bucket = total ? Math.floor((finished / total) * 10) : 10;
    const message = `Research run ${event.runId}: ${finished}/${total} outcomes · failed ${failed} · remaining ${remaining} · ${event.status}`;
    if (activity) activity.message(message);
    else if (event.type !== "progress" || bucket > lastBucket) write(message);
    lastBucket = bucket;
  };
}

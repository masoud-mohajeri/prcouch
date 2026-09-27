import type { CategorizationProgressEvent } from "../analysis/categorization.js";

type Spinner = {
  message(message?: string): void;
};

/** Renders categorization progress inside the existing terminal loading spinner. */
export function createCategorizationProgressReporter(activity: Spinner) {
  return (event: CategorizationProgressEvent): void => {
    if (event.type === "loaded") {
      activity.message(formatProgress(0, event.total));
      return;
    }
    activity.message(formatProgress(event.completed, event.total));
  };
}

function formatProgress(completed: number, total: number): string {
  if (!total) return "No pending comments to categorize";
  const width = 10;
  const filled = Math.round((completed / total) * width);
  return `Categorizing comments [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${completed}/${total}`;
}

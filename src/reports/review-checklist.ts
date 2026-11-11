import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisStore } from "../analysis/store.js";
import { getReportDirectory } from "./report.js";

/** Rebuilds generated checklists from persisted instructions, never model-selected paths. */
export async function generateReviewChecklists(
  store: AnalysisStore,
  outputDirectory = getReportDirectory(),
): Promise<string[]> {
  const rows = await store.listReviewInstructions();
  const projects = new Map<
    number,
    { name: string; instructions: Set<string> }
  >();
  for (const row of rows) {
    let project = projects.get(row.projectId);
    if (!project) {
      project = { name: row.projectName, instructions: new Set() };
      projects.set(row.projectId, project);
    }
    const instruction = row.instruction?.replace(/\s+/g, " ").trim();
    if (instruction) project.instructions.add(instruction);
  }
  if (!projects.size) return [];
  await mkdir(outputDirectory, { recursive: true });
  const paths: string[] = [];
  for (const [id, project] of projects) {
    const path = join(outputDirectory, `review-checklist-${id}.md`);
    const name = project.name.replace(/\s+/g, " ").trim();
    const lines = [...project.instructions].map(
      (instruction) => `- ${instruction}`,
    );
    await writeFile(
      path,
      [
        `# Review checklist: ${name}`,
        "",
        "Generated from categorized review comments. Regenerated automatically; local edits will be overwritten.",
        "",
        ...(lines.length
          ? lines
          : ["No actionable review instructions saved yet."]),
        "",
      ].join("\n"),
      "utf8",
    );
    paths.push(path);
  }
  return paths;
}

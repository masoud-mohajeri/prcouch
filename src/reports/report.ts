import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

import {
  AnalysisStore,
  resolutionSchema,
  type AnalyzedCommentRecord,
} from "../analysis/store.js";
import {
  CommentCategoryPolicy,
  type CommentCategory,
} from "../analysis/category-policy.js";

export const reportFiltersSchema = z
  .object({
    authorName: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    resolution: resolutionSchema.optional(),
    analyzedAfter: z.string().datetime({ offset: true }).optional(),
    analyzedBefore: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine(({ analyzedAfter, analyzedBefore }, context) => {
    if (
      analyzedAfter &&
      analyzedBefore &&
      new Date(analyzedAfter) > new Date(analyzedBefore)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzedAfter"],
        message: "analyzedAfter must be before or equal to analyzedBefore.",
      });
    }
  });

export type ReportFilters = z.input<typeof reportFiltersSchema>;

export type GeneratedReport = {
  path: string;
  generatedAt: string;
  recordCount: number;
  filters: z.output<typeof reportFiltersSchema>;
};

export function getReportDirectory(env = process.env): string {
  const configuredDirectory = env.REPORT_OUTPUT_DIR?.trim();
  return resolve(configuredDirectory || "reports");
}

/** Generates a local, self-contained and offline-safe HTML analysis report. */
export class CommentReportGenerator {
  readonly outputDirectory: string;

  constructor(
    private readonly analysisStore: AnalysisStore,
    private readonly categoryPolicy: CommentCategoryPolicy,
    outputDirectory = getReportDirectory(),
  ) {
    this.outputDirectory = resolve(outputDirectory);
  }

  async generate(filters: ReportFilters = {}): Promise<GeneratedReport> {
    const parsedFilters = reportFiltersSchema.parse(filters);
    const [records, categories] = await Promise.all([
      this.analysisStore.list(),
      this.categoryPolicy.list(),
    ]);
    const filteredRecords = records
      .filter((record) => matchesFilters(record, parsedFilters))
      .sort(
        (left, right) =>
          right.analyzedAt.localeCompare(left.analyzedAt) ||
          right.id.localeCompare(left.id),
      );
    const generatedAt = new Date().toISOString();
    const outputPath = this.createOutputPath(generatedAt);
    await mkdir(this.outputDirectory, { recursive: true });
    await writeFile(
      outputPath,
      renderReport(filteredRecords, categories, parsedFilters, generatedAt),
      "utf8",
    );

    return {
      path: outputPath,
      generatedAt,
      recordCount: filteredRecords.length,
      filters: parsedFilters,
    };
  }

  private createOutputPath(generatedAt: string): string {
    const timestamp = generatedAt.replace(/[:.]/g, "-");
    const candidate = resolve(
      this.outputDirectory,
      `comment-report-${timestamp}-${randomBytes(4).toString("hex")}.html`,
    );
    if (!candidate.startsWith(`${this.outputDirectory}${sep}`)) {
      throw new Error(
        "Generated report path escaped the configured report directory.",
      );
    }
    return candidate;
  }
}

function matchesFilters(
  record: AnalyzedCommentRecord,
  filters: z.output<typeof reportFiltersSchema>,
): boolean {
  if (filters.category && record.category !== filters.category) return false;
  if (filters.resolution && record.resolution !== filters.resolution)
    return false;
  if (filters.authorName) {
    const needle = filters.authorName.toLocaleLowerCase();
    if (
      !record.comment.author.name.toLocaleLowerCase().includes(needle) &&
      !record.comment.author.username.toLocaleLowerCase().includes(needle)
    )
      return false;
  }
  const analyzedAt = new Date(record.analyzedAt);
  return (
    (!filters.analyzedAfter || analyzedAt >= new Date(filters.analyzedAfter)) &&
    (!filters.analyzedBefore || analyzedAt <= new Date(filters.analyzedBefore))
  );
}

function renderReport(
  records: AnalyzedCommentRecord[],
  categories: CommentCategory[],
  filters: z.output<typeof reportFiltersSchema>,
  generatedAt: string,
): string {
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  );
  const openCount = records.filter(
    (record) =>
      record.resolution === "open" || record.resolution === "needs_discussion",
  ).length;
  const resolvedCount = records.length - openCount;
  const projectNames = [
    ...new Set(records.map((record) => record.project.pathWithNamespace)),
  ];
  const projectSummary =
    projectNames.length === 0
      ? "No analyzed comments"
      : projectNames.length === 1
        ? projectNames[0]
        : `${projectNames.length} projects`;
  const nonce = randomBytes(16).toString("base64");
  const filterSummary = formatFilters(filters);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>GitLab comment analysis report</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
    body { max-width: 1440px; margin: 0 auto; padding: 32px; background: #f5f7fb; }
    h1 { margin: 0; font-size: 28px; } h2 { margin: 0 0 14px; font-size: 18px; }
    .muted { color: #586174; } .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    .cards, .charts { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin: 18px 0; }
    .card, .chart, .table-card { background: #fff; color: #172033; border: 1px solid #dce2ee; border-radius: 12px; padding: 18px; box-shadow: 0 2px 5px rgba(20, 34, 58, .04); }
    .metric { font-size: 30px; font-weight: 700; margin-top: 7px; } .filters { margin: 8px 0 0; font-size: 14px; }
    .chart { overflow: auto; } svg { min-width: 470px; width: 100%; height: auto; display: block; } .bar-label { font-size: 12px; fill: #34405a; } .bar-value { font-size: 12px; fill: #34405a; font-weight: 600; }
    .bar { fill: #4f6bed; } .bar-alt { fill: #12a594; } .axis { stroke: #dce2ee; }
    .controls { display: flex; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    input { min-width: 250px; padding: 9px 10px; border: 1px solid #b9c4d8; border-radius: 7px; font: inherit; color: inherit; background: transparent; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; } th, td { padding: 10px 8px; border-top: 1px solid #e5e9f2; text-align: left; vertical-align: top; }
    th { border-top: 0; white-space: nowrap; } th button { all: unset; cursor: pointer; font-weight: 700; } th button:hover { color: #4f6bed; }
    code { font-size: 12px; word-break: break-all; } .excerpt { max-width: 360px; white-space: pre-wrap; } a { color: #3455cf; } .empty { padding: 28px 0; text-align: center; color: #586174; }
    @media (prefers-color-scheme: dark) { :root, body { background: #101624; color: #e6ebf5; } .card, .chart, .table-card { background: #182033; color: #e6ebf5; border-color: #2e3a52; } .muted { color: #aeb8ca; } .bar-label, .bar-value { fill: #d7deeb; } .axis, th, td { border-color: #2e3a52; } a { color: #9bb0ff; } input { border-color: #52617c; } }
  </style>
</head>
<body>
  <header class="header">
    <div><h1>GitLab comment analysis report</h1><p class="muted">${escapeHtml(projectSummary)} · Generated ${escapeHtml(formatDate(generatedAt))}</p><p class="filters">${escapeHtml(filterSummary)}</p></div>
    <div class="muted">Self-contained offline report</div>
  </header>
  <section class="cards" aria-label="Summary">
    ${metricCard("Analyzed comments", records.length)}
    ${metricCard("Open / needs discussion", openCount)}
    ${metricCard("Resolved analysis", resolvedCount)}
    ${metricCard("Authors", new Set(records.map((record) => record.comment.author.username)).size)}
  </section>
  ${
    records.length === 0
      ? '<p class="empty">No matching analyzed comments.</p>'
      : `
  <section class="charts" aria-label="Charts">
    ${barChart(
      "Categories",
      countBy(
        records,
        (record) => categoryById.get(record.category)?.label ?? record.category,
      ),
      "bar",
    )}
    ${barChart(
      "Resolutions",
      countBy(records, (record) => record.resolution.replace(/_/g, " ")),
      "bar-alt",
    )}
    ${barChart(
      "Comments by author",
      countBy(records, (record) => record.comment.author.name),
      "bar",
    )}
    ${barChart(
      "Analysis trend",
      countBy(records, (record) => record.analyzedAt.slice(0, 10)),
      "bar-alt",
      true,
    )}
  </section>
  ${detailTable(records, categoryById)}`
  }
  <script nonce="${nonce}">
    const query = document.querySelector('#comment-filter');
    const rows = [...document.querySelectorAll('#comment-rows tr')];
    query?.addEventListener('input', () => {
      const term = query.value.toLocaleLowerCase();
      rows.forEach((row) => { row.hidden = !row.textContent.toLocaleLowerCase().includes(term); });
    });
    document.querySelectorAll('[data-sort-column]').forEach((button) => {
      let ascending = true;
      button.addEventListener('click', () => {
        const column = Number(button.dataset.sortColumn);
        rows.sort((left, right) => left.cells[column].textContent.localeCompare(right.cells[column].textContent, undefined, { numeric: true }) * (ascending ? 1 : -1));
        ascending = !ascending;
        document.querySelector('#comment-rows').append(...rows);
      });
    });
  </script>
</body>
</html>`;
}

function metricCard(label: string, value: number): string {
  return `<article class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${value}</div></article>`;
}

function countBy<T>(
  items: T[],
  key: (item: T) => string,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = key(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

// When changing or adding charts, replace this hand-built SVG with a proper
// charting library (for example, @observablehq/plot) while preserving the
// report's self-contained, offline output.
function barChart(
  title: string,
  items: Array<[string, number]>,
  colorClass: string,
  chronological = false,
): string {
  const sorted = chronological
    ? [...items].sort((left, right) => left[0].localeCompare(right[0]))
    : items;
  if (sorted.length === 0)
    return `<article class="chart"><h2>${escapeHtml(title)}</h2><p class="muted">No data</p></article>`;
  const max = Math.max(...sorted.map(([, value]) => value));
  const rowHeight = 30;
  const height = 45 + sorted.length * rowHeight;
  const rows = sorted
    .map(([label, value], index) => {
      const y = 30 + index * rowHeight;
      const width = Math.max(2, Math.round((value / max) * 320));
      return `<text class="bar-label" x="0" y="${y + 12}">${escapeHtml(label)}</text><rect class="${colorClass}" x="150" y="${y}" width="${width}" height="16" rx="4"></rect><text class="bar-value" x="${160 + width}" y="${y + 12}">${value}</text>`;
    })
    .join("");
  return `<article class="chart"><h2>${escapeHtml(title)}</h2><svg viewBox="0 0 520 ${height}" role="img" aria-label="${escapeHtml(title)} bar chart"><line class="axis" x1="150" y1="20" x2="150" y2="${height - 8}"></line>${rows}</svg></article>`;
}

function detailTable(
  records: AnalyzedCommentRecord[],
  categoryById: Map<string, CommentCategory>,
): string {
  const rows = records
    .map((record) => {
      const category =
        categoryById.get(record.category)?.label ?? record.category;
      const source = safeLink(record.comment.sourceUrl, "Source");
      const mergeRequest = safeLink(
        record.mergeRequest.webUrl,
        `!${record.mergeRequest.iid}`,
      );
      return `<tr>
      <td>${escapeHtml(record.comment.author.name)}<br><span class="muted">@${escapeHtml(record.comment.author.username)}</span></td>
      <td>${escapeHtml(category)}</td>
      <td>${escapeHtml(record.resolution.replace(/_/g, " "))}</td>
      <td>${mergeRequest}<br><span class="muted">${escapeHtml(record.mergeRequest.title)}</span></td>
      <td>${escapeHtml(formatLocation(record))}</td>
      <td>${record.comment.commitSha ? `<code>${escapeHtml(record.comment.commitSha)}</code>` : "—"}</td>
      <td>${escapeHtml(formatDate(record.comment.createdAt))}<br><span class="muted">analyzed ${escapeHtml(formatDate(record.analyzedAt))}</span></td>
      <td class="excerpt">${escapeHtml(record.comment.body)}</td>
      <td>${source}</td>
    </tr>`;
    })
    .join("");
  return `<section class="table-card"><div class="controls"><h2>Analyzed comments</h2><input id="comment-filter" type="search" placeholder="Filter this report" aria-label="Filter analyzed comments"></div><div style="overflow:auto"><table><thead><tr>
    ${["Author", "Category", "Resolution", "Merge request", "Location", "Commit SHA", "Dates", "Comment", "Link"].map((label, index) => `<th><button type="button" data-sort-column="${index}">${escapeHtml(label)} ↕</button></th>`).join("")}
  </tr></thead><tbody id="comment-rows">${rows}</tbody></table></div></section>`;
}

function formatLocation(record: AnalyzedCommentRecord): string {
  const { oldPath, newPath, oldLine, newLine } = record.comment.location;
  if (newPath && newLine) return `${newPath}:${newLine}`;
  if (oldPath && oldLine) return `${oldPath}:${oldLine} (deleted)`;
  if (newPath) return newPath;
  if (oldPath) return oldPath;
  return "—";
}

function formatFilters(filters: z.output<typeof reportFiltersSchema>): string {
  const entries = Object.entries(filters);
  return entries.length === 0
    ? "All saved analyses"
    : `Filters: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function safeLink(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "—";
    return `<a href="${escapeAttribute(url.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  } catch {
    return "—";
  }
}

function escapeHtml(value: string | number): string {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character]!,
  );
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

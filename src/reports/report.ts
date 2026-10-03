import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

import {
  AnalysisStore,
  type AnalysisCoverage,
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
    commentCreatedAfter: z.string().datetime({ offset: true }).optional(),
    commentCreatedBefore: z.string().datetime({ offset: true }).optional(),
    analyzedAfter: z.string().datetime({ offset: true }).optional(),
    analyzedBefore: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine(
    (
      {
        analyzedAfter,
        analyzedBefore,
        commentCreatedAfter,
        commentCreatedBefore,
      },
      context,
    ) => {
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
      if (
        commentCreatedAfter &&
        commentCreatedBefore &&
        new Date(commentCreatedAfter) > new Date(commentCreatedBefore)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["commentCreatedAfter"],
          message:
            "commentCreatedAfter must be before or equal to commentCreatedBefore.",
        });
      }
    },
  );

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
    const [records, categories, coverage] = await Promise.all([
      this.analysisStore.list(),
      this.categoryPolicy.list(),
      this.analysisStore.getCoverage(),
    ]);
    const filteredRecords = records
      .filter((record) => matchesFilters(record, parsedFilters))
      .sort(compareRecords);
    const generatedAt = new Date().toISOString();
    const outputPath = this.createOutputPath(generatedAt);
    await mkdir(this.outputDirectory, { recursive: true });
    await writeFile(
      outputPath,
      renderReport(
        filteredRecords,
        categories,
        coverage,
        parsedFilters,
        generatedAt,
      ),
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
  const commentCreatedAt = new Date(record.comment.createdAt);
  if (
    filters.commentCreatedAfter &&
    commentCreatedAt < new Date(filters.commentCreatedAfter)
  )
    return false;
  if (
    filters.commentCreatedBefore &&
    commentCreatedAt > new Date(filters.commentCreatedBefore)
  )
    return false;
  const analyzedAt = new Date(record.analyzedAt);
  return (
    (!filters.analyzedAfter || analyzedAt >= new Date(filters.analyzedAfter)) &&
    (!filters.analyzedBefore || analyzedAt <= new Date(filters.analyzedBefore))
  );
}

function compareRecords(
  left: AnalyzedCommentRecord,
  right: AnalyzedCommentRecord,
): number {
  return (
    right.comment.createdAt.localeCompare(left.comment.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function renderReport(
  records: AnalyzedCommentRecord[],
  categories: CommentCategory[],
  coverage: AnalysisCoverage,
  filters: z.output<typeof reportFiltersSchema>,
  generatedAt: string,
): string {
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  );
  const unresolvedRecords = records.filter(isUnresolved);
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
  const reviewDateRange = formatReviewDateRange(records);
  const latestAnalysis = formatLatestAnalysis(records);
  const coverageLabel = formatCoverage(coverage);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Review Health Report</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
    body { max-width: 1440px; margin: 0 auto; padding: 32px; background: #f5f7fb; }
    h1 { margin: 0; font-size: 28px; } h2 { margin: 0 0 14px; font-size: 18px; }
    .muted { color: #586174; } .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    .cards, .category-list { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin: 18px 0; }
    .card, .table-card, .category-card, .comment-card { background: #fff; color: #172033; border: 1px solid #dce2ee; border-radius: 12px; padding: 18px; box-shadow: 0 2px 5px rgba(20, 34, 58, .04); }
    .metric { font-size: 30px; font-weight: 700; margin-top: 7px; } .filters { margin: 8px 0 0; font-size: 14px; } .meta { margin: 5px 0 0; font-size: 13px; }
    .category-card { appearance: none; width: 100%; cursor: pointer; text-align: left; font: inherit; } .category-card:hover, .category-card:focus-visible, .category-card[aria-pressed="true"] { border-color: #4f6bed; box-shadow: 0 0 0 3px rgba(79, 107, 237, .16); outline: none; } .category-card .metric { color: #3455cf; } .category-card-title { display: flex; justify-content: space-between; gap: 12px; font-weight: 700; } .category-card-count { margin: 8px 0 0; font-size: 14px; }
    .controls { display: flex; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    input { min-width: 250px; padding: 9px 10px; border: 1px solid #b9c4d8; border-radius: 7px; font: inherit; color: inherit; background: transparent; } button.clear { border: 1px solid #b9c4d8; border-radius: 7px; padding: 8px 10px; cursor: pointer; font: inherit; color: inherit; background: transparent; }
    .comment-list { display: grid; gap: 12px; } .comment-card { box-shadow: none; } .comment-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0; font-size: 13px; } .comment-body { white-space: pre-wrap; margin: 12px 0; } .comment-action { margin: 10px 0 0; padding: 10px; border-left: 3px solid #4f6bed; background: rgba(79, 107, 237, .06); } code { font-size: 12px; word-break: break-all; } a { color: #3455cf; } .empty { padding: 28px 0; text-align: center; color: #586174; }
    @media (prefers-color-scheme: dark) { :root, body { background: #101624; color: #e6ebf5; } .card, .table-card, .category-card, .comment-card { background: #182033; color: #e6ebf5; border-color: #2e3a52; } .muted { color: #aeb8ca; } a { color: #9bb0ff; } input, button.clear { border-color: #52617c; } .comment-action { background: rgba(155, 176, 255, .12); } }
  </style>
</head>
<body>
  <header class="header">
    <div><h1>Review Health Report</h1><p class="muted">${escapeHtml(projectSummary)} · Generated ${escapeHtml(formatDate(generatedAt))}</p><p class="meta muted">Review dates: ${escapeHtml(reviewDateRange)} · ${escapeHtml(coverageLabel)} · ${escapeHtml(latestAnalysis)}</p><p class="filters">${escapeHtml(filterSummary)}</p></div>
    <div class="muted">Self-contained offline report</div>
  </header>
  <section class="cards" aria-label="Summary">
    ${metricCard("Analyzed comments", records.length)}
    ${metricCard("Issue categories", new Set(records.map((record) => record.category)).size)}
    ${metricCard("Unresolved", unresolvedRecords.length)}
    ${metricCard("Affected merge requests", new Set(records.map((record) => record.mergeRequest.webUrl)).size)}
  </section>
  ${
    records.length === 0
      ? '<p class="empty">No matching analyzed comments.</p>'
      : `
  ${categoryDistribution(records, categoryById)}
  ${categoryCommentList(records, categoryById)}`
  }
  <script nonce="${nonce}">
    const query = document.querySelector('#comment-filter');
    const categoryCards = [...document.querySelectorAll('[data-category]')];
    const comments = [...document.querySelectorAll('[data-comment-category]')];
    const detail = document.querySelector('#category-details');
    const title = document.querySelector('#selected-category');
    const clear = document.querySelector('#clear-category');
    let selectedCategory = '';
    const updateComments = () => {
      const term = query?.value.toLocaleLowerCase() ?? '';
      comments.forEach((comment) => {
        const matchesCategory = selectedCategory && comment.dataset.commentCategory === selectedCategory;
        comment.hidden = !matchesCategory || !comment.textContent.toLocaleLowerCase().includes(term);
      });
    };
    categoryCards.forEach((card) => {
      card.addEventListener('click', () => {
        selectedCategory = card.dataset.category ?? '';
        categoryCards.forEach((item) => item.setAttribute('aria-pressed', String(item === card)));
        detail.hidden = !selectedCategory;
        title.textContent = card.dataset.categoryLabel ?? 'Category comments';
        clear.hidden = false;
        query.value = '';
        updateComments();
      });
    });
    clear?.addEventListener('click', () => {
      selectedCategory = '';
      categoryCards.forEach((card) => card.setAttribute('aria-pressed', 'false'));
      detail.hidden = true;
      clear.hidden = true;
      query.value = '';
      updateComments();
    });
    query?.addEventListener('input', () => {
      updateComments();
    });
  </script>
</body>
</html>`;
}

function metricCard(label: string, value: string | number): string {
  return `<article class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${value}</div></article>`;
}

function isUnresolved(record: AnalyzedCommentRecord): boolean {
  return (
    record.resolution === "open" || record.resolution === "needs_discussion"
  );
}

function categoryDistribution(
  records: AnalyzedCommentRecord[],
  categoryById: Map<string, CommentCategory>,
): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
  }
  const cards = [...counts.entries()]
    .sort(
      ([leftId, leftCount], [rightId, rightCount]) =>
        rightCount - leftCount || leftId.localeCompare(rightId),
    )
    .map(([id, count]) => {
      const category = categoryById.get(id);
      const label = category?.label ?? id;
      const percent = (count / records.length) * 100;
      return `<button class="category-card" type="button" data-category="${escapeAttribute(id)}" data-category-label="${escapeAttribute(label)}" aria-pressed="false"><span class="category-card-title"><span>${escapeHtml(label)}</span><span class="muted">${escapeHtml(category?.severity ?? "uncategorized")}</span></span><div class="metric">${percent.toFixed(0)}%</div><p class="category-card-count">${count} ${count === 1 ? "comment" : "comments"}</p><p class="muted">${escapeHtml(category?.description ?? "No category description available.")}</p></button>`;
    })
    .join("");
  return `<section class="table-card" aria-labelledby="category-distribution-title"><h2 id="category-distribution-title">Comments by issue category</h2><p class="muted">Each percentage is the share of included comments. Select a category to see its corresponding comments.</p><div class="category-list">${cards}</div></section>`;
}

function categoryCommentList(
  records: AnalyzedCommentRecord[],
  categoryById: Map<string, CommentCategory>,
): string {
  const comments = records
    .map((record) => {
      const category = categoryById.get(record.category);
      const mergeRequest = safeLink(
        record.mergeRequest.webUrl,
        `!${record.mergeRequest.iid} ${record.mergeRequest.title}`,
      );
      const source = safeLink(record.comment.sourceUrl, "Open comment");
      return `<article class="comment-card" data-comment-category="${escapeAttribute(record.category)}" hidden><div class="comment-meta"><span>${escapeHtml(record.resolution.replace(/_/g, " "))}</span><span>${mergeRequest}</span><span>${escapeHtml(formatLocation(record))}</span><span>${escapeHtml(formatDate(record.comment.createdAt))}</span></div><div class="comment-body">${escapeHtml(record.comment.body)}</div><div class="comment-action"><strong>Recommended action:</strong> ${escapeHtml(category?.action ?? "—")}${record.rationale ? `<br><strong>Rationale:</strong> ${escapeHtml(record.rationale)}` : ""}</div><p class="muted">${source}</p></article>`;
    })
    .join("");
  return `<section id="category-details" class="table-card" hidden><div class="controls"><h2 id="selected-category">Category comments</h2><button id="clear-category" class="clear" type="button" hidden>Back to categories</button><input id="comment-filter" type="search" placeholder="Search selected comments" aria-label="Search selected comments"></div><div class="comment-list">${comments}</div></section>`;
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
  const entries = Object.entries(filters).filter(
    ([key]) => key !== "authorName",
  );
  return entries.length === 0
    ? Object.hasOwn(filters, "authorName")
      ? "Filtered saved analyses"
      : "All saved analyses"
    : `Filters: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}`;
}

function formatReviewDateRange(records: AnalyzedCommentRecord[]): string {
  if (records.length === 0) return "No review dates";
  const dates = records
    .map((record) => record.comment.createdAt)
    .sort((left, right) => left.localeCompare(right));
  return `${formatDate(dates[0]!)} to ${formatDate(dates.at(-1)!)}`;
}

function formatLatestAnalysis(records: AnalyzedCommentRecord[]): string {
  if (records.length === 0) return "No analysis timestamp";
  const latest = records
    .map((record) => record.analyzedAt)
    .sort((left, right) => right.localeCompare(left))[0]!;
  return `Last analyzed ${formatDate(latest)}`;
}

function formatCoverage(coverage: AnalysisCoverage): string {
  if (coverage.totalComments === 0)
    return "Analysis coverage: no saved comments";
  const percent = Math.round(
    (coverage.completedComments / coverage.totalComments) * 100,
  );
  return `Analysis coverage: ${coverage.completedComments}/${coverage.totalComments} (${percent}%)`;
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

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
    const parsedFilters = normalizeFilters(reportFiltersSchema.parse(filters));
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

/** Converts UI sentinel values into the absent filters they represent. */
function normalizeFilters(
  filters: z.output<typeof reportFiltersSchema>,
): z.output<typeof reportFiltersSchema> {
  const normalized = { ...filters };
  if (normalized.category?.toLocaleLowerCase() === "all")
    delete normalized.category;
  if (isUnboundedStart(normalized.commentCreatedAfter))
    delete normalized.commentCreatedAfter;
  if (isUnboundedEnd(normalized.commentCreatedBefore))
    delete normalized.commentCreatedBefore;
  if (isUnboundedStart(normalized.analyzedAfter))
    delete normalized.analyzedAfter;
  if (isUnboundedEnd(normalized.analyzedBefore))
    delete normalized.analyzedBefore;
  return normalized;
}

function isUnboundedStart(value: string | undefined): boolean {
  return (
    value !== undefined &&
    Date.parse(value) === Date.parse("0001-01-01T00:00:00Z")
  );
}

function isUnboundedEnd(value: string | undefined): boolean {
  return (
    value !== undefined &&
    Date.parse(value) === Date.parse("9999-12-31T23:59:59Z")
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Review Health Report</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
    body { max-width: 1440px; margin: 0 auto; padding: 32px 32px 90px; background: #f5f7fb; }
    h1 { margin: 0; font-size: 28px; } h2 { margin: 0 0 14px; font-size: 18px; }
    .muted { color: #586174; } .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin: 18px 0; }
    .card, .category-group, .comment-card { background: #fff; color: #172033; border: 1px solid #dce2ee; border-radius: 12px; padding: 18px; box-shadow: 0 2px 5px rgba(20, 34, 58, .04); }
    .metric { font-size: 30px; font-weight: 700; margin-top: 7px; } .filters { margin: 8px 0 0; font-size: 14px; } .meta { margin: 5px 0 0; font-size: 13px; }
    * { box-sizing: border-box; }
    a { color: #3455cf; text-underline-offset: 3px; }
    a:focus-visible, pre:focus-visible { outline: 3px solid #4f6bed; outline-offset: 4px; }
    .back-to-top { position: fixed; bottom: 20px; right: 20px; z-index: 10; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 12px 16px; border-radius: 24px; background: #3455cf; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; box-shadow: 0 4px 14px rgba(20, 34, 58, .25); }
    .back-to-top:hover { background: #2841a1; }
    @media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
    .category-nav { margin: 24px 0; padding: 20px; border: 1px solid #dce2ee; border-radius: 12px; background: #fff; }
    .category-links { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .category-links a { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 14px; border: 1px solid #dce2ee; border-radius: 8px; text-decoration: none; }
    .category-links a:hover { background: rgba(79, 107, 237, .08); border-color: #4f6bed; }
    .category-links .category-count { padding: 2px 7px; border-radius: 6px; background: rgba(79, 107, 237, .1); }
    .category-group { margin: 24px 0; scroll-margin-top: 24px; }
    .category-group:target { border-color: #4f6bed; }
    .category-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: baseline; }
    .category-heading h2 { margin: 0; }
    .category-heading-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
    .category-count, .back-link { font-size: 14px; }
    .comment-list { display: grid; gap: 18px; margin-top: 20px; }
    .comment-card { min-width: 0; padding: 24px; box-shadow: none; }
    .comment-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 20px; font-size: 13px; overflow-wrap: anywhere; }
    .resolution { padding: 4px 9px; border-radius: 6px; background: rgba(79, 107, 237, .1); }
    .content-label { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .comment-body { margin: 0 0 22px; padding: 16px 18px; border-inline-start: 3px solid #4f6bed; border-radius: 6px; background: rgba(79, 107, 237, .05); font-size: 16px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; text-align: start; unicode-bidi: plaintext; }
    .comment-code { max-width: 100%; margin: 0; padding: 18px; border: 1px solid #dce2ee; border-radius: 8px; background: #f5f7fb; color: #172033; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.7; tab-size: 4; white-space: pre; overflow-x: auto; text-align: left; }
    .comment-code code { display: block; width: max-content; min-width: 100%; font: inherit; unicode-bidi: isolate; }
    .diff-line { display: inline-block; min-width: 100%; }
    .diff-added { background: #e6ffed; color: #14532d; }
    .diff-removed { background: #ffeef0; color: #7f1d1d; }
    .diff-hunk { background: #eaf2ff; color: #3455cf; }
    .comment-action { margin-top: 22px; padding-top: 18px; border-top: 1px solid #dce2ee; }
    .comment-action p { margin: 0; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; text-align: start; unicode-bidi: plaintext; }
    .empty { padding: 28px 0; text-align: center; color: #586174; }
    @media (max-width: 640px) { body { padding: 16px 16px 90px; } .header { flex-direction: column; gap: 8px; } .category-group, .category-nav { padding: 16px; } .comment-card { padding: 16px; } .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (prefers-color-scheme: dark) { :root, body { background: #101624; color: #e6ebf5; } .card, .category-group, .category-nav, .comment-card { background: #182033; color: #e6ebf5; border-color: #2e3a52; } .category-links a, .comment-code, .comment-action { border-color: #2e3a52; } .comment-code { background: #101624; color: #e6ebf5; } .muted { color: #aeb8ca; } a { color: #9bb0ff; } .comment-body, .resolution, .category-links .category-count { background: rgba(155, 176, 255, .08); } }
    @media (prefers-color-scheme: dark) { .diff-added { background: #173b27; color: #b7f5c8; } .diff-removed { background: #46252b; color: #ffc1c9; } .diff-hunk { background: #1e2d48; color: #9bb0ff; } }
  </style>
</head>
<body id="top">
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
  ${categoryCommentGroups(records, categoryById)}`
  }
  <a class="back-to-top" href="#top" aria-label="Scroll to top"><span aria-hidden="true">↑</span> Back to top</a>
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

function categoryCommentGroups(
  records: AnalyzedCommentRecord[],
  categoryById: Map<string, CommentCategory>,
): string {
  const byCategory = new Map<string, AnalyzedCommentRecord[]>();
  for (const record of records) {
    const categoryRecords = byCategory.get(record.category) ?? [];
    categoryRecords.push(record);
    byCategory.set(record.category, categoryRecords);
  }

  const groups = [...byCategory.entries()].sort(([left], [right]) => {
    const leftLabel = categoryById.get(left)?.label ?? left;
    const rightLabel = categoryById.get(right)?.label ?? right;
    return leftLabel.localeCompare(rightLabel);
  });
  const links = groups
    .map(([categoryId, categoryRecords], index) => {
      const label = categoryById.get(categoryId)?.label ?? categoryId;
      const percentage = (
        (categoryRecords.length / records.length) *
        100
      ).toFixed(1);
      return `<li><a href="#category-${index}"><span>${escapeHtml(label)}</span><span class="category-count">${categoryRecords.length} (${percentage}%)</span></a></li>`;
    })
    .join("");
  const sections = groups
    .map(([categoryId, categoryRecords], index) => {
      const category = categoryById.get(categoryId);
      const label = category?.label ?? categoryId;
      const comments = categoryRecords
        .map((record) => {
          const code =
            record.savedComment?.codeThatComentIsOn ||
            "No code context available";
          return `<article class="comment-card">
  <div class="comment-meta muted">
    <span class="resolution">${escapeHtml(record.resolution.replace(/_/g, " "))}</span>
    <bdi dir="ltr">${escapeHtml(formatLocation(record))}</bdi>
    <time datetime="${escapeAttribute(record.comment.createdAt)}">${escapeHtml(formatDate(record.comment.createdAt))}</time>
    ${safeLink(record.comment.sourceUrl, "Open in GitLab")}
  </div>
  <h3 class="content-label muted">Comment</h3>
  <div class="comment-body" dir="auto">${escapeHtml(record.comment.body)}</div>
  <h3 class="content-label muted">Code context</h3>
  <pre class="comment-code" dir="ltr" tabindex="0" aria-label="Code context"><code>${renderCodeContext(code)}</code></pre>
  <div class="comment-action">
    <h3 class="content-label muted">Recommended solution</h3>
    <p dir="auto">${escapeHtml(category?.action ?? "—")}</p>
  </div>
</article>`;
        })
        .join("");
      return `<section class="category-group" id="category-${index}" aria-labelledby="category-heading-${index}"><div class="category-heading"><h2 id="category-heading-${index}">${escapeHtml(label)}</h2><div class="category-heading-meta"><span class="muted category-count">${categoryRecords.length} ${categoryRecords.length === 1 ? "comment" : "comments"}</span><a class="back-link" href="#categories">Back to categories</a></div></div><p class="muted" dir="auto">${escapeHtml(category?.description ?? "No category description available.")}</p><div class="comment-list">${comments}</div></section>`;
    })
    .join("");
  return `<nav class="category-nav" id="categories" aria-labelledby="categories-heading"><h2 id="categories-heading">Browse categories</h2><ul class="category-links">${links}</ul></nav>${sections}`;
}

function renderCodeContext(code: string): string {
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(code))
    return escapeHtml(code);

  return code
    .split(/\r?\n/)
    .map((line) => {
      const style = line.startsWith("@@ ")
        ? " diff-hunk"
        : line.startsWith("+")
          ? " diff-added"
          : line.startsWith("-")
            ? " diff-removed"
            : "";
      return `<span class="diff-line${style}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
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
    ([, value]) => value !== undefined,
  );
  return entries.length === 0
    ? "All saved analyses"
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

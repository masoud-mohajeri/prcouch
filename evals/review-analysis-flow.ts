import { AnalysisStore } from "../src/analysis-store.js";
import { AnalyzedCommentService } from "../src/analyzed-comment-service.js";
import { CommentCategoryPolicy } from "../src/comment-category-policy.js";
import { CommentService } from "../src/comments.js";
import { GitLabClient } from "../src/gitlab.js";
import { CommentReportGenerator } from "../src/report.js";

/**
 * Deterministic, no-network fixture for the complete review-analysis flow.
 * It is deliberately separate from model-scored eval cases so it can exercise
 * local persistence and HTML output without an API key or a real GitLab token.
 */
export async function executeReviewAnalysisFlow(paths: { analysisPath: string; reportDirectory: string }) {
  const requests: string[] = [];
  const client = new GitLabClient(
    { baseUrl: "https://gitlab.example.test", token: "eval-token", project: "acme/billing" },
    async (input) => {
      const url = new URL(input.toString());
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/projects/acme%2Fbilling")) {
        return json({ id: 8, name: "Billing", path_with_namespace: "acme/billing", web_url: "https://gitlab.example.test/acme/billing" });
      }
      if (url.pathname.endsWith("/merge_requests")) {
        return json([{ id: 41, iid: 41, title: "Validate invoice numbers", state: "merged", web_url: "https://gitlab.example.test/acme/billing/-/merge_requests/41" }]);
      }
      if (url.pathname.endsWith("/merge_requests/41/discussions")) {
        return json([{
          id: "discussion-41",
          individual_note: true,
          notes: [{
            id: 410,
            body: "Please validate the invoice number before saving.",
            author: { name: "Ava", username: "ava" },
            created_at: "2026-01-02T03:04:05.000Z",
            updated_at: "2026-01-02T03:04:05.000Z",
            system: false,
            resolvable: true,
            resolved: false,
            position: { new_path: "src/invoice.ts", new_line: 18, head_sha: "invoice-head-sha" },
          }],
        }]);
      }
      return new Response("Not found", { status: 404, statusText: "Not Found" });
    },
  );
  const comments = new CommentService(client);
  const analysisStore = new AnalysisStore(paths.analysisPath);
  const categoryPolicy = new CommentCategoryPolicy();
  const analyzedComments = new AnalyzedCommentService(analysisStore, categoryPolicy);
  const reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy, paths.reportDirectory);

  const project = await client.getProject();
  const page = await comments.list({ authorName: "ava", state: "all", includeResolved: true, limit: 25 });
  const comment = page.items[0];
  const record = await analyzedComments.save({
    project: { id: project.id, pathWithNamespace: project.path_with_namespace, webUrl: project.web_url },
    mergeRequest: { iid: comment.mergeRequest.iid, title: comment.mergeRequest.title, webUrl: comment.mergeRequest.webUrl },
    comment: {
      discussionId: comment.discussionId,
      noteId: comment.noteId,
      body: comment.body,
      sourceUrl: comment.sourceUrl,
      createdAt: comment.createdAt,
      author: comment.author,
      location: comment.location,
      commitSha: comment.commitSha,
    },
    category: "correctness",
    resolution: "addressed",
    rationale: "Validation prevents malformed invoice data.",
    analyzedBy: "evaluation fixture",
  });
  const report = await reportGenerator.generate({ authorName: "ava" });

  return { project, comments: page.items, record, report, requests };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

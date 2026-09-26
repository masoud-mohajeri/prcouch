import "dotenv/config";
import OpenAI from "openai";

import { GitLabClient, requireGitLabConfig } from "./gitlab.js";
import { CommentService } from "./comments.js";
import { AnalysisStore } from "./analysis-store.js";
import { CommentCategoryPolicy } from "./comment-category-policy.js";
import { AnalyzedCommentService } from "./analyzed-comment-service.js";
import { CommentReportGenerator } from "./report.js";
import { gitLabToolNames, rawRequiredFields } from "./gitlab-tool-contracts.js";
import { getOpenAIConfig } from "./openai-config.js";

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error('Usage: npm run openai-sdk -- "List unresolved review comments"');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY?.trim()) {
  console.error("Missing required configuration: OPENAI_API_KEY.");
  process.exit(1);
}

const { baseURL, apiMode } = getOpenAIConfig();
if (apiMode === "chat") {
  console.error("OPENAI_API_MODE=chat is supported by npm start and npm run evals; npm run openai-sdk requires a Responses API-compatible endpoint.");
  process.exit(1);
}
const client = new OpenAI(baseURL ? { baseURL } : undefined);
const gitlab = new GitLabClient(requireGitLabConfig());
const comments = new CommentService(gitlab);
const analysisStore = new AnalysisStore();
const categoryPolicy = new CommentCategoryPolicy();
const analyzedComments = new AnalyzedCommentService(analysisStore, categoryPolicy);
const reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy);

const tools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: gitLabToolNames.generateCommentReport,
    description: "Generate a self-contained, offline HTML report from saved analyzed comments. It includes summary counts, category/resolution/author/trend charts, and a sortable, filterable detail table. Optional filters only select saved analyses; the output path is controlled by REPORT_OUTPUT_DIR, never by the caller.",
    parameters: {
      type: "object",
      properties: {
        authorName: { type: "string", minLength: 1 },
        category: { type: "string", minLength: 1 },
        resolution: { type: "string", enum: ["open", "addressed", "wont_fix", "duplicate", "needs_discussion", "not_actionable"] },
        analyzedAfter: { type: "string", format: "date-time" },
        analyzedBefore: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.getCommentCategories,
    description: "List the approved review-comment categories, their severity, default resolution, and recommended action. Use this before categorizing or saving an analyzed comment.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.saveAnalyzedComment,
    description: "Persist a categorized analysis of one GitLab review comment in the configured local analysis JSON store. Use only after get_comment_categories has supplied an approved category, resolution, and evidence-based rationale. Source comment identity and source URL are required; no caller-selected output path is allowed.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 1 },
            pathWithNamespace: { type: "string", minLength: 1 },
            webUrl: { type: "string", format: "uri" },
          },
          required: ["id", "pathWithNamespace", "webUrl"],
          additionalProperties: false,
        },
        mergeRequest: {
          type: "object",
          properties: {
            iid: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1 },
            webUrl: { type: "string", format: "uri" },
          },
          required: ["iid", "title", "webUrl"],
          additionalProperties: false,
        },
        comment: {
          type: "object",
          properties: {
            discussionId: { type: "string", minLength: 1 },
            noteId: { type: "integer", minimum: 1 },
            body: { type: "string" },
            sourceUrl: { type: "string", format: "uri" },
            createdAt: { type: "string", format: "date-time" },
            author: {
              type: "object",
              properties: { name: { type: "string", minLength: 1 }, username: { type: "string", minLength: 1 } },
              required: ["name", "username"],
              additionalProperties: false,
            },
            location: {
              type: "object",
              properties: {
                oldPath: { type: ["string", "null"] },
                newPath: { type: ["string", "null"] },
                oldLine: { type: ["integer", "null"], minimum: 1 },
                newLine: { type: ["integer", "null"], minimum: 1 },
              },
              required: ["oldPath", "newPath", "oldLine", "newLine"],
              additionalProperties: false,
            },
            commitSha: { type: ["string", "null"] },
          },
          required: ["discussionId", "noteId", "body", "sourceUrl", "createdAt", "author", "location", "commitSha"],
          additionalProperties: false,
        },
        category: { type: "string", minLength: 1 },
        resolution: { type: "string", enum: ["open", "addressed", "wont_fix", "duplicate", "needs_discussion", "not_actionable"] },
        rationale: { type: "string", minLength: 1 },
        analyzedBy: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
      },
      required: rawRequiredFields.saveAnalyzedComment,
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.listComments,
    description: "List normalized human GitLab review comments. Each item includes discussionHistory with every note and reply in that discussion, ordered oldest to newest, including system events. authorName is a case-insensitive substring of the item's author name or username. Inline comments include old/new file and line fields plus commitSha when GitLab provides a diff SHA; commitSha is not a commit message.",
    parameters: {
      type: "object",
      properties: {
        authorName: { type: "string", minLength: 1 },
        mergeRequestIid: { type: "integer", minimum: 1 },
        state: { type: "string", enum: ["all", "opened", "closed", "merged"] },
        createdAfter: { type: "string", format: "date-time" },
        createdBefore: { type: "string", format: "date-time" },
        includeResolved: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", pattern: "^[0-9]+$" },
      },
      required: rawRequiredFields.listComments,
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.getProject,
    description: "Get canonical metadata for the configured GitLab project. Use this when asked for the project name; the returned name is its display name.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.listRecentMergeRequests,
    description: "List the most recently updated GitLab merge requests in the configured project. Use this before retrieving their comments.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        state: { type: "string", enum: ["all", "opened", "closed", "merged"] },
      },
      required: rawRequiredFields.listRecentMergeRequests,
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: gitLabToolNames.getMergeRequestDiscussions,
    description: "Get every GitLab discussion and every note in its reply history, including inline/diff comments, for one merge request. Pass the merge request IID, not its database ID.",
    parameters: {
      type: "object",
      properties: { mergeRequestIid: { type: "integer", minimum: 1 } },
      required: rawRequiredFields.getMergeRequestDiscussions,
      additionalProperties: false,
    },
    strict: true,
  },
];

let response = await client.responses.create({
  model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  instructions: "You are a concise GitLab review analysis assistant. Use tools for GitLab data. For a request for the configured GitLab project's name or metadata, call get_project; do not infer a display name from configuration. Use list_comments for filtered review-comment requests; it returns author, merge request, inline location, and commit SHA context. Before save_analyzed_comment, call get_comment_categories and select one approved category, a permitted resolution, and a short evidence-based rationale. Use generate_comment_report when asked for an HTML report of saved analyses; it returns the local generated file path. For comments on recent merge requests, first list the requested number of merge requests, then retrieve discussions for each result. Never claim data was retrieved unless the tool confirms it.",
  input,
  tools,
});

while (response.output.some((item) => item.type === "function_call")) {
  const outputs = await Promise.all(response.output
    .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call")
    .map(async (call) => {
      const args = JSON.parse(call.arguments) as {
        limit?: number;
        state?: "all" | "opened" | "closed" | "merged";
        mergeRequestIid?: number;
        authorName?: string;
        createdAfter?: string;
        createdBefore?: string;
        includeResolved?: boolean;
        cursor?: string;
        project?: { id: number; pathWithNamespace: string; webUrl: string };
        mergeRequest?: { iid: number; title: string; webUrl: string };
        comment?: {
          discussionId: string;
          noteId: number;
          body: string;
          sourceUrl: string;
          createdAt: string;
          author: { name: string; username: string };
          location: { oldPath: string | null; newPath: string | null; oldLine: number | null; newLine: number | null };
          commitSha: string | null;
        };
        category?: string;
        resolution?: "open" | "addressed" | "wont_fix" | "duplicate" | "needs_discussion" | "not_actionable";
        rationale?: string;
        analyzedBy?: string;
        model?: string;
        analyzedAfter?: string;
        analyzedBefore?: string;
      };
      let output: unknown;
      switch (call.name) {
        case "get_project":
          output = { project: await gitlab.getProject() };
          break;
        case "list_recent_merge_requests":
          output = { mergeRequests: await gitlab.listRecentMergeRequests(args.limit!, args.state) };
          break;
        case "get_merge_request_discussions":
          output = { discussions: await gitlab.listMergeRequestDiscussions(args.mergeRequestIid!) };
          break;
        case "list_comments":
          output = await comments.list({
            authorName: args.authorName,
            mergeRequestIid: args.mergeRequestIid,
            state: args.state!,
            createdAfter: args.createdAfter,
            createdBefore: args.createdBefore,
            includeResolved: args.includeResolved!,
            limit: args.limit!,
            cursor: args.cursor,
          });
          break;
        case "get_comment_categories":
          output = { categories: await categoryPolicy.list() };
          break;
        case "save_analyzed_comment":
          output = {
            record: await analyzedComments.save({
              project: args.project!,
              mergeRequest: args.mergeRequest!,
              comment: args.comment!,
              category: args.category!,
              resolution: args.resolution!,
              rationale: args.rationale,
              analyzedBy: args.analyzedBy,
              model: args.model,
            }),
          };
          break;
        case "generate_comment_report":
          output = {
            report: await reportGenerator.generate({
              authorName: args.authorName,
              category: args.category,
              resolution: args.resolution,
              analyzedAfter: args.analyzedAfter,
              analyzedBefore: args.analyzedBefore,
            }),
          };
          break;
        default:
          output = { error: `Unsupported tool: ${call.name}` };
      }
      return { type: "function_call_output" as const, call_id: call.call_id, output: JSON.stringify(output) };
    }));

  response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    previous_response_id: response.id,
    input: outputs,
    tools,
  });
}

console.log(response.output_text);

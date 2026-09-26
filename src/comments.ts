import type { DiffPosition, GitLabClient, MergeRequest, Project } from "./gitlab.js";

const MAX_MERGE_REQUESTS = 100;
const DISCUSSION_CONCURRENCY = 5;

export type CommentQuery = {
  authorName?: string;
  mergeRequestIid?: number;
  state: "all" | "opened" | "closed" | "merged";
  createdAfter?: string;
  createdBefore?: string;
  includeResolved: boolean;
  limit: number;
  cursor?: string;
};

export type NormalizedComment = {
  discussionId: string;
  noteId: number;
  body: string;
  author: { name: string; username: string };
  createdAt: string;
  updatedAt: string;
  /** Direct GitLab anchor for this note. */
  sourceUrl: string;
  resolvable: boolean;
  resolved: boolean;
  mergeRequest: {
    iid: number;
    title: string;
    state: string;
    webUrl: string;
  };
  location: {
    oldPath: string | null;
    newPath: string | null;
    oldLine: number | null;
    newLine: number | null;
  };
  /** GitLab diff SHA, not a human-readable commit message. */
  commitSha: string | null;
};

export type CommentPage = {
  project: Project;
  items: NormalizedComment[];
  nextCursor: string | null;
  total: number;
};

/**
 * Reads, normalizes, and filters human GitLab review comments. It deliberately
 * does not mutate GitLab and bounds fan-out across merge requests.
 */
export class CommentService {
  constructor(
    private readonly gitlab: GitLabClient,
    private readonly maxMergeRequests = MAX_MERGE_REQUESTS,
    private readonly discussionConcurrency = DISCUSSION_CONCURRENCY,
  ) {}

  async list(query: CommentQuery): Promise<CommentPage> {
    const offset = parseCursor(query.cursor);
    const projectRequest = this.gitlab.getProject();
    const mergeRequestsRequest = query.mergeRequestIid
      ? this.gitlab.getMergeRequest(query.mergeRequestIid).then((mergeRequest) => [mergeRequest])
      : this.gitlab.listRecentMergeRequests(this.maxMergeRequests, query.state);
    const [project, mergeRequests] = await Promise.all([projectRequest, mergeRequestsRequest]);
    const selectedMergeRequests = query.state === "all"
      ? mergeRequests
      : mergeRequests.filter((mergeRequest) => mergeRequest.state === query.state);
    const discussions = await mapWithConcurrency(
      selectedMergeRequests,
      this.discussionConcurrency,
      async (mergeRequest) => ({
        mergeRequest,
        discussions: await this.gitlab.listMergeRequestDiscussions(mergeRequest.iid),
      }),
    );
    const createdAfter = query.createdAfter ? dateFromFilter(query.createdAfter, "createdAfter") : undefined;
    const createdBefore = query.createdBefore ? dateFromFilter(query.createdBefore, "createdBefore") : undefined;
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      throw new Error("createdAfter must be before or equal to createdBefore.");
    }

    const comments = discussions
      .flatMap(({ mergeRequest, discussions: mergeRequestDiscussions }) => mergeRequestDiscussions.flatMap((discussion) =>
        discussion.notes
          .filter((note) => !note.system)
          .map((note) => normalizeComment(mergeRequest, discussion.id, note)),
      ))
      .filter((comment) => matchesQuery(comment, query, createdAfter, createdBefore))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.noteId - left.noteId);
    const items = comments.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;

    return {
      project,
      items,
      total: comments.length,
      nextCursor: nextOffset < comments.length ? String(nextOffset) : null,
    };
  }
}

function normalizeComment(
  mergeRequest: MergeRequest,
  discussionId: string,
  note: {
    id: number;
    body: string;
    author: { name: string; username: string };
    created_at: string;
    updated_at: string;
    resolvable: boolean;
    resolved: boolean;
    position?: DiffPosition;
  },
): NormalizedComment {
  const position = note.position;
  return {
    discussionId,
    noteId: note.id,
    body: note.body,
    author: note.author,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    sourceUrl: `${mergeRequest.web_url}#note_${note.id}`,
    resolvable: note.resolvable,
    resolved: note.resolved,
    mergeRequest: {
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      state: mergeRequest.state,
      webUrl: mergeRequest.web_url,
    },
    location: {
      oldPath: position?.old_path ?? null,
      newPath: position?.new_path ?? null,
      oldLine: position?.old_line ?? null,
      newLine: position?.new_line ?? null,
    },
    commitSha: position?.head_sha ?? position?.base_sha ?? null,
  };
}

function matchesQuery(
  comment: NormalizedComment,
  query: CommentQuery,
  createdAfter: Date | undefined,
  createdBefore: Date | undefined,
): boolean {
  if (!query.includeResolved && comment.resolved) return false;
  if (query.authorName) {
    const needle = query.authorName.trim().toLocaleLowerCase();
    if (!comment.author.name.toLocaleLowerCase().includes(needle)
      && !comment.author.username.toLocaleLowerCase().includes(needle)) return false;
  }
  const createdAt = dateFromFilter(comment.createdAt, `comment ${comment.noteId} createdAt`);
  return (!createdAfter || createdAt >= createdAfter) && (!createdBefore || createdAt <= createdBefore);
}

function dateFromFilter(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid ISO-8601 date-time.`);
  return date;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("cursor must be a non-negative integer string.");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error("cursor is too large.");
  return offset;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  requestedConcurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, requestedConcurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

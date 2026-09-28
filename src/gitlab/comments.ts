import pMap from "p-map";

import type {
  DiffPosition,
  GitLabClient,
  MergeRequestChange,
  MergeRequestCommit,
  MergeRequest,
  MergeRequestNote,
  Project,
} from "./client.js";

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
  /** Every note in this discussion, ordered from oldest to newest. */
  discussionHistory: DiscussionHistoryNote[];
  /** The matching merge-request diff hunk, when GitLab supplied one. */
  codeThatComentIsOn: string;
  /** The matching commit's human-readable message, when GitLab supplied one. */
  commitMessage: string;
};

export type DiscussionHistoryNote = {
  noteId: number;
  body: string;
  author: { name: string; username: string };
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  location: {
    oldPath: string | null;
    newPath: string | null;
    oldLine: number | null;
    newLine: number | null;
  };
  commitSha: string | null;
};

export type CommentPage = {
  project: Project;
  items: NormalizedComment[];
  nextCursor: string | null;
  total: number;
};

/**
 * Reads, normalizes, and filters human GitLab merge-request comments. This
 * includes inline discussion notes and general MR notes, which GitLab exposes
 * through separate endpoints. It deliberately does not mutate GitLab and
 * bounds fan-out across merge requests.
 */
export class CommentService {
  constructor(
    private readonly gitlab: GitLabClient,
    private readonly maxMergeRequests = MAX_MERGE_REQUESTS,
    private readonly discussionConcurrency = DISCUSSION_CONCURRENCY,
  ) {}

  async list(query: CommentQuery): Promise<CommentPage> {
    const offset = parseCursor(query.cursor);
    const createdAfter = query.createdAfter
      ? dateFromFilter(query.createdAfter, "createdAfter")
      : undefined;
    const createdBefore = query.createdBefore
      ? dateFromFilter(query.createdBefore, "createdBefore")
      : undefined;
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      throw new Error("createdAfter must be before or equal to createdBefore.");
    }
    const projectRequest = this.gitlab.getProject();
    const mergeRequestsRequest = query.mergeRequestIid
      ? this.gitlab
          .getMergeRequest(query.mergeRequestIid)
          .then((mergeRequest) => [mergeRequest])
      : this.gitlab.listRecentMergeRequests(this.maxMergeRequests, query.state);
    const [project, mergeRequests] = await Promise.all([
      projectRequest,
      mergeRequestsRequest,
    ]);
    const selectedMergeRequests =
      query.state === "all"
        ? mergeRequests
        : mergeRequests.filter(
            (mergeRequest) => mergeRequest.state === query.state,
          );
    const discussions = await pMap(
      selectedMergeRequests,
      async (mergeRequest) => {
        const [discussions, notes] = await Promise.all([
          this.gitlab.listMergeRequestDiscussionDetails(mergeRequest.iid),
          this.gitlab.listMergeRequestNotes(mergeRequest.iid),
        ]);
        const inlineNotes = [
          ...discussions.flatMap((discussion) => discussion.notes),
          ...notes,
        ].filter((note) => !note.system && note.position);
        const [changes, commits] = inlineNotes.length
          ? await this.loadInlineContext(mergeRequest.iid)
          : [[], []];
        return { mergeRequest, discussions, notes, changes, commits };
      },
      { concurrency: this.discussionConcurrency },
    );
    const comments = discussions
      .flatMap(
        ({
          mergeRequest,
          discussions: mergeRequestDiscussions,
          notes: mergeRequestNotes,
          changes,
          commits,
        }) => [
          ...mergeRequestDiscussions.flatMap((discussion) => {
            const discussionHistory = discussion.notes
              .map((note) => normalizeDiscussionHistoryNote(mergeRequest, note))
              .sort(
                (left, right) =>
                  left.createdAt.localeCompare(right.createdAt) ||
                  left.noteId - right.noteId,
              );
            return discussion.notes
              .filter((note) => !note.system)
              .map((note) =>
                normalizeComment(
                  mergeRequest,
                  discussion.id,
                  note,
                  discussionHistory,
                  changes,
                  commits,
                ),
              );
          }),
          ...mergeRequestNotes
            .filter((note) => !note.system)
            .map((note) =>
              normalizeGeneralNote(mergeRequest, note, changes, commits),
            ),
        ],
      )
      .filter(
        (comment) => !this.gitlab.isInvalidCommentUser(comment.author.username),
      )
      .filter((comment) =>
        matchesQuery(comment, query, createdAfter, createdBefore),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.noteId - left.noteId,
      );
    const items = comments.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;

    return {
      project,
      items,
      total: comments.length,
      nextCursor: nextOffset < comments.length ? String(nextOffset) : null,
    };
  }

  private async loadInlineContext(
    mergeRequestIid: number,
  ): Promise<[MergeRequestChange[], MergeRequestCommit[]]> {
    try {
      return await Promise.all([
        this.gitlab.getMergeRequestChanges(mergeRequestIid),
        this.gitlab.listMergeRequestCommits(mergeRequestIid),
      ]);
    } catch {
      // A missing optional context must not hide the review comment itself.
      return [[], []];
    }
  }
}

function normalizeGeneralNote(
  mergeRequest: MergeRequest,
  note: MergeRequestNote,
  changes: MergeRequestChange[],
  commits: MergeRequestCommit[],
): NormalizedComment {
  const normalizedNote = normalizeDiscussionHistoryNote(mergeRequest, note);
  return {
    discussionId: note.discussion_id ?? `note:${note.id}`,
    ...normalizedNote,
    mergeRequest: {
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      state: mergeRequest.state,
      webUrl: mergeRequest.web_url,
    },
    discussionHistory: [normalizedNote],
    codeThatComentIsOn: codeFor(normalizedNote, changes),
    commitMessage: messageFor(normalizedNote.commitSha, commits),
  };
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
    system: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    position?: DiffPosition;
  },
  discussionHistory: DiscussionHistoryNote[],
  changes: MergeRequestChange[],
  commits: MergeRequestCommit[],
): NormalizedComment {
  const normalizedNote = normalizeDiscussionHistoryNote(mergeRequest, note);
  return {
    discussionId,
    ...normalizedNote,
    mergeRequest: {
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      state: mergeRequest.state,
      webUrl: mergeRequest.web_url,
    },
    discussionHistory,
    codeThatComentIsOn: codeFor(normalizedNote, changes),
    commitMessage: messageFor(normalizedNote.commitSha, commits),
  };
}

function codeFor(
  note: DiscussionHistoryNote,
  changes: MergeRequestChange[],
): string {
  const change = changes.find(
    (candidate) =>
      candidate.new_path === note.location.newPath ||
      candidate.old_path === note.location.oldPath,
  );
  if (!change) return "";
  return matchingDiffHunk(
    change.diff,
    note.location.newLine,
    note.location.oldLine,
  );
}

function matchingDiffHunk(
  diff: string,
  newLine: number | null,
  oldLine: number | null,
): string {
  const target = newLine ?? oldLine;
  if (target === null) return "";
  const hunks = diff.split(/(?=^@@ )/m);
  return (
    hunks.find((hunk) => {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m.exec(hunk);
      if (!match) return false;
      const start = newLine === null ? Number(match[1]) : Number(match[3]);
      const count = Number(
        newLine === null ? (match[2] ?? 1) : (match[4] ?? 1),
      );
      return target >= start && target < start + count;
    }) ?? ""
  );
}

function messageFor(sha: string | null, commits: MergeRequestCommit[]): string {
  if (!sha) return "";
  return (
    commits.find(
      (commit) =>
        commit.id === sha ||
        commit.id.startsWith(sha) ||
        sha.startsWith(commit.id),
    )?.message ?? ""
  );
}

function normalizeDiscussionHistoryNote(
  mergeRequest: MergeRequest,
  note: {
    id: number;
    body: string;
    author: { name: string; username: string };
    created_at: string;
    updated_at: string;
    system: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    position?: DiffPosition;
  },
): DiscussionHistoryNote {
  const position = note.position;
  return {
    noteId: note.id,
    body: note.body,
    author: note.author,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    sourceUrl: `${mergeRequest.web_url}#note_${note.id}`,
    system: note.system,
    resolvable: note.resolvable ?? false,
    resolved: note.resolved ?? false,
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
    if (
      !comment.author.name.toLocaleLowerCase().includes(needle) &&
      !comment.author.username.toLocaleLowerCase().includes(needle)
    )
      return false;
  }
  const createdAt = dateFromFilter(
    comment.createdAt,
    `comment ${comment.noteId} createdAt`,
  );
  return (
    (!createdAfter || createdAt >= createdAfter) &&
    (!createdBefore || createdAt <= createdBefore)
  );
}

function dateFromFilter(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`${field} must be a valid ISO-8601 date-time.`);
  return date;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor))
    throw new Error("cursor must be a non-negative integer string.");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error("cursor is too large.");
  return offset;
}

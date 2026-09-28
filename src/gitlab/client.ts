import { ServiceError } from "../errors.js";

export type GitLabConfig = {
  baseUrl: string;
  token: string;
  project: string;
  /** Usernames whose notes are excluded from compact discussions. */
  invalidCommentUsers?: readonly string[];
};

/** Connection settings shared by project discovery and project-scoped calls. */
export type GitLabConnectionConfig = Omit<GitLabConfig, "project">;

type Fetch = typeof fetch;
type ExpectedBody = "array" | "object";

const requestTimeoutMs = 30_000;

export type MergeRequest = {
  id: number;
  iid: number;
  title: string;
  state: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  author: { name: string; username: string } | null;
};

/** Canonical metadata returned by GitLab for the configured project. */
export type Project = {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
};

/** Raw GitLab discussion data used by the detailed review-comment service. */
export type DiscussionDetails = {
  id: string;
  individual_note: boolean;
  notes: Array<{
    id: number;
    body: string;
    author: { name: string; username: string };
    created_at: string;
    updated_at: string;
    system: boolean;
    resolvable: boolean;
    resolved: boolean;
    position?: DiffPosition;
  }>;
};

/** A general (non-threaded) note attached to a merge request. */
export type MergeRequestNote = {
  id: number;
  body: string;
  author: { name: string; username: string };
  created_at: string;
  updated_at: string;
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: DiffPosition;
  discussion_id?: string;
};

/** A compact representation of a discussion attached to a diff. */
export type Discussion = {
  /** The new-side line when available, otherwise the old-side line. */
  line: number | null;
  /** All non-excluded note bodies in the discussion, in GitLab's order. */
  comments: string[];
  /** The new-side path when available, otherwise the old-side path. */
  filePath: string | null;
};

/** GitLab supplies this only for comments attached to a merge-request diff. */
export type DiffPosition = {
  old_path?: string;
  new_path?: string;
  old_line?: number;
  new_line?: number;
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
};

/** A file diff returned for a merge request. */
export type MergeRequestChange = {
  old_path: string;
  new_path: string;
  diff: string;
};

export type MergeRequestCommit = {
  id: string;
  message: string;
};

export function requireGitLabConnectionConfig(
  env = process.env,
): GitLabConnectionConfig {
  const token = env.GITLAB_TOKEN?.trim();
  const baseUrl = env.GITLAB_URL?.trim();
  const missing = [!baseUrl && "GITLAB_URL", !token && "GITLAB_TOKEN"].filter(
    Boolean,
  );
  if (missing.length) {
    throw new ServiceError(
      "gitlab",
      "configuration",
      `Missing required GitLab configuration: ${missing.join(", ")}.`,
    );
  }

  try {
    const url = new URL(baseUrl!);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ServiceError(
      "gitlab",
      "configuration",
      "GITLAB_URL must be a valid http(s) URL.",
    );
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    token: token!,
    invalidCommentUsers: parseInvalidCommentUsers(
      env.GITLAB_INVALID_COMMENT_USERS,
    ),
  };
}

/**
 * Backwards-compatible configuration helper for callers that already know the
 * project. The CLI discovers the project interactively instead.
 */
export function requireGitLabConfig(env = process.env): GitLabConfig {
  const project = env.GITLAB_PROJECT?.trim();
  if (!project) {
    throw new ServiceError(
      "gitlab",
      "configuration",
      "Missing required GitLab configuration: GITLAB_PROJECT.",
    );
  }

  return { ...requireGitLabConnectionConfig(env), project };
}

/** A read-only client for the two GitLab endpoints the agent needs. */
export class GitLabClient {
  constructor(
    private readonly config: GitLabConfig,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /**
   * Retrieve the project's canonical metadata. `config.project` may be either
   * its numeric GitLab ID or its namespace/project path; neither is assumed to
   * be the project's current display name.
   */
  async getProject(): Promise<Project> {
    return this.get<Project>(
      `/projects/${encodeURIComponent(this.config.project)}`,
      "object",
    );
  }

  /**
   * List projects the token's user is a member of, newest activity first.
   * GitLab caps a page at 100 entries, so follow its pagination headers.
   */
  async listProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    let page = 1;

    while (page <= 100) {
      const { data, nextPage } = await this.getPage<Project[]>(
        `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`,
        "array",
      );
      projects.push(...data);
      if (!nextPage) return projects;
      const nextPageNumber = Number(nextPage);
      if (!Number.isInteger(nextPageNumber) || nextPageNumber <= page) {
        throw new ServiceError(
          "gitlab",
          "incompatible-response",
          "GitLab returned an invalid pagination response.",
        );
      }
      page = nextPageNumber;
    }

    throw new ServiceError(
      "gitlab",
      "incompatible-response",
      "GitLab returned more than 100 pages of projects.",
    );
  }

  async listRecentMergeRequests(
    limit: number,
    state: "all" | "opened" | "closed" | "merged" = "all",
    authorUsername?: string,
  ): Promise<MergeRequest[]> {
    const params = new URLSearchParams({
      state,
      order_by: "updated_at",
      sort: "desc",
      per_page: String(limit),
    });
    const normalizedAuthorUsername = authorUsername?.trim();
    if (normalizedAuthorUsername)
      params.set("author_username", normalizedAuthorUsername);

    return this.get<MergeRequest[]>(
      `/projects/${encodeURIComponent(this.config.project)}/merge_requests?${params}`,
      "array",
    );
  }

  async getMergeRequest(mergeRequestIid: number): Promise<MergeRequest> {
    return this.get<MergeRequest>(
      `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}`,
      "object",
    );
  }

  async listMergeRequestDiscussions(
    mergeRequestIid: number,
  ): Promise<Discussion[]> {
    const discussions =
      await this.listMergeRequestDiscussionDetails(mergeRequestIid);

    return discussions
      .map((discussion) =>
        toDiscussion(discussion, this.config.invalidCommentUsers ?? []),
      )
      .filter((discussion): discussion is Discussion => discussion !== null);
  }

  /**
   * Retrieve GitLab's complete discussion payload for consumers that need note
   * metadata beyond the compact public discussion view.
   */
  async listMergeRequestDiscussionDetails(
    mergeRequestIid: number,
  ): Promise<DiscussionDetails[]> {
    const discussions: DiscussionDetails[] = [];
    let page = 1;

    // GitLab paginates these results. A high bound prevents a malformed server
    // response from keeping an agent tool call open indefinitely.
    while (page <= 100) {
      const { data, nextPage } = await this.getPage<DiscussionDetails[]>(
        `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}/discussions?per_page=100&page=${page}`,
        "array",
      );
      discussions.push(...data);
      if (!nextPage) return discussions;
      const nextPageNumber = Number(nextPage);
      if (!Number.isInteger(nextPageNumber) || nextPageNumber <= page) {
        throw new ServiceError(
          "gitlab",
          "incompatible-response",
          "GitLab returned an invalid pagination response.",
        );
      }
      page = nextPageNumber;
    }

    throw new ServiceError(
      "gitlab",
      "incompatible-response",
      "GitLab returned more than 100 pages of discussions for this merge request.",
    );
  }

  /**
   * Retrieve general merge-request notes. GitLab keeps these separate from
   * discussion notes, so callers that present all human comments need both
   * endpoints.
   */
  async listMergeRequestNotes(
    mergeRequestIid: number,
  ): Promise<MergeRequestNote[]> {
    const notes: MergeRequestNote[] = [];
    let page = 1;

    while (page <= 100) {
      const { data, nextPage } = await this.getPage<MergeRequestNote[]>(
        `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}/notes?per_page=100&page=${page}`,
        "array",
      );
      notes.push(...data);
      if (!nextPage) return notes;
      const nextPageNumber = Number(nextPage);
      if (!Number.isInteger(nextPageNumber) || nextPageNumber <= page) {
        throw new ServiceError(
          "gitlab",
          "incompatible-response",
          "GitLab returned an invalid pagination response.",
        );
      }
      page = nextPageNumber;
    }

    throw new ServiceError(
      "gitlab",
      "incompatible-response",
      "GitLab returned more than 100 pages of merge request notes.",
    );
  }

  /** Retrieves the diff hunks needed to preserve code context for inline notes. */
  async getMergeRequestChanges(
    mergeRequestIid: number,
  ): Promise<MergeRequestChange[]> {
    const response = await this.get<{ changes: MergeRequestChange[] }>(
      `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}/changes`,
      "object",
    );
    if (!Array.isArray(response.changes)) {
      throw new ServiceError(
        "gitlab",
        "incompatible-response",
        "GitLab merge-request changes did not include a changes array.",
      );
    }
    return response.changes;
  }

  /** Retrieves merge-request commits so an inline note can retain its message. */
  async listMergeRequestCommits(
    mergeRequestIid: number,
  ): Promise<MergeRequestCommit[]> {
    const commits: MergeRequestCommit[] = [];
    let page = 1;
    while (page <= 100) {
      const { data, nextPage } = await this.getPage<MergeRequestCommit[]>(
        `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}/commits?per_page=100&page=${page}`,
        "array",
      );
      commits.push(...data);
      if (!nextPage) return commits;
      const nextPageNumber = Number(nextPage);
      if (!Number.isInteger(nextPageNumber) || nextPageNumber <= page) {
        throw new ServiceError(
          "gitlab",
          "incompatible-response",
          "GitLab returned an invalid pagination response.",
        );
      }
      page = nextPageNumber;
    }
    throw new ServiceError(
      "gitlab",
      "incompatible-response",
      "GitLab returned more than 100 pages of merge-request commits.",
    );
  }

  private async get<T>(path: string, expectedBody: ExpectedBody): Promise<T> {
    return (await this.request<T>(path, expectedBody)).data;
  }

  private async getPage<T>(
    path: string,
    expectedBody: ExpectedBody,
  ): Promise<{ data: T; nextPage: string | null }> {
    const response = await this.request<T>(path, expectedBody);
    return { data: response.data, nextPage: response.nextPage };
  }

  private async request<T>(
    path: string,
    expectedBody: ExpectedBody,
  ): Promise<{ data: T; nextPage: string | null }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/api/v4${path}`, {
        headers: {
          "PRIVATE-TOKEN": this.config.token,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (cause) {
      const timedOut = isTimeoutError(cause);
      throw new ServiceError(
        "gitlab",
        timedOut ? "timeout" : "network",
        timedOut ? "GitLab request timed out." : "Could not connect to GitLab.",
        { cause },
      );
    }

    if (!response.ok) {
      throw new ServiceError(
        "gitlab",
        getGitLabErrorKind(response.status),
        `GitLab request failed (${response.status} ${response.statusText}).`,
        {
          statusCode: response.status,
          requestId:
            response.headers.get("x-request-id") ??
            response.headers.get("x-gitlab-request-id") ??
            undefined,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        },
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      throw new ServiceError(
        "gitlab",
        "incompatible-response",
        "GitLab returned an invalid JSON response.",
        { cause },
      );
    }

    if (!isExpectedBody(data, expectedBody)) {
      throw new ServiceError(
        "gitlab",
        "incompatible-response",
        `GitLab returned an unexpected ${expectedBody} response.`,
      );
    }

    return {
      data: data as T,
      nextPage: response.headers.get("x-next-page"),
    };
  }
}

function toDiscussion(
  discussion: DiscussionDetails,
  invalidCommentUsers: readonly string[],
): Discussion | null {
  const notes = discussion.notes.filter(
    (note) => !isInvalidCommentUser(note.author.username, invalidCommentUsers),
  );
  if (!notes.length) return null;

  // The anchor normally lives on the first note, while replies commonly have
  // no position. Keep looking so malformed/partial payloads still retain one.
  const position = discussion.notes.find((note) => note.position)?.position;
  return {
    line: position?.new_line ?? position?.old_line ?? null,
    comments: notes.map((note) => note.body),
    filePath: position?.new_path ?? position?.old_path ?? null,
  };
}

function isInvalidCommentUser(
  username: string,
  invalidCommentUsers: readonly string[],
): boolean {
  const normalizedUsername = username.trim().toLocaleLowerCase();
  return invalidCommentUsers.some(
    (invalidUser) => invalidUser.toLocaleLowerCase() === normalizedUsername,
  );
}

function parseInvalidCommentUsers(value: string | undefined): string[] {
  return [
    ...new Set(
      value
        ?.split(",")
        .map((username) => username.trim())
        .filter(Boolean)
        .map((username) => username.toLocaleLowerCase()) ?? [],
    ),
  ];
}

function getGitLabErrorKind(
  statusCode: number,
): "authentication" | "not-found" | "rate-limit" | "server" | "request" {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 404) return "not-found";
  if (statusCode === 429) return "rate-limit";
  if (statusCode >= 500) return "server";
  return "request";
}

function isExpectedBody(value: unknown, expected: ExpectedBody): boolean {
  return expected === "array"
    ? Array.isArray(value)
    : typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof Error &&
      /(?:timeout|timed out|abort)/i.test(error.message))
  );
}

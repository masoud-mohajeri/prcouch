export type GitLabConfig = {
  baseUrl: string;
  token: string;
  project: string;
};

type Fetch = typeof fetch;

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

export type Discussion = {
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

export function requireGitLabConfig(env = process.env): GitLabConfig {
  const token = env.GITLAB_TOKEN?.trim();
  const project = env.GITLAB_PROJECT?.trim();
  const baseUrl = env.GITLAB_URL?.trim();
  const missing = [
    !baseUrl && "GITLAB_URL",
    !token && "GITLAB_TOKEN",
    !project && "GITLAB_PROJECT",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing required GitLab configuration: ${missing.join(", ")}.`);
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    token: token!,
    project: project!,
  };
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
    return this.get<Project>(`/projects/${encodeURIComponent(this.config.project)}`);
  }

  async listRecentMergeRequests(
    limit: number,
    state: "all" | "opened" | "closed" | "merged" = "all",
  ): Promise<MergeRequest[]> {
    const params = new URLSearchParams({
      state,
      order_by: "updated_at",
      sort: "desc",
      per_page: String(limit),
    });

    return this.get<MergeRequest[]>(`/projects/${encodeURIComponent(this.config.project)}/merge_requests?${params}`);
  }

  async getMergeRequest(mergeRequestIid: number): Promise<MergeRequest> {
    return this.get<MergeRequest>(
      `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}`,
    );
  }

  async listMergeRequestDiscussions(mergeRequestIid: number): Promise<Discussion[]> {
    const discussions: Discussion[] = [];
    let page = 1;

    // GitLab paginates these results. A high bound prevents a malformed server
    // response from keeping an agent tool call open indefinitely.
    while (page <= 100) {
      const { data, nextPage } = await this.getPage<Discussion[]>(
        `/projects/${encodeURIComponent(this.config.project)}/merge_requests/${mergeRequestIid}/discussions?per_page=100&page=${page}`,
      );
      discussions.push(...data);
      if (!nextPage) return discussions;
      page = Number(nextPage);
      if (!Number.isInteger(page) || page < 1) {
        throw new Error("GitLab returned an invalid pagination response.");
      }
    }

    throw new Error("GitLab returned more than 100 pages of discussions for this merge request.");
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).data;
  }

  private async getPage<T>(path: string): Promise<{ data: T; nextPage: string | null }> {
    const response = await this.request<T>(path);
    return { data: response.data, nextPage: response.nextPage };
  }

  private async request<T>(path: string): Promise<{ data: T; nextPage: string | null }> {
    const response = await this.fetchImpl(`${this.config.baseUrl}/api/v4${path}`, {
      headers: {
        "PRIVATE-TOKEN": this.config.token,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`GitLab request failed (${response.status} ${response.statusText}).`);
    }

    return {
      data: await response.json() as T,
      nextPage: response.headers.get("x-next-page"),
    };
  }
}

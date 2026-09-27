import { describe, expect, it, vi } from "vitest";

import {
  GitLabClient,
  requireGitLabConnectionConfig,
} from "../src/gitlab/client.js";

const config = {
  baseUrl: "https://gitlab.example.test",
  token: "secret",
  project: "team/service",
};

describe("GitLabClient", () => {
  it("rejects incomplete GitLab configuration", () => {
    expect(() =>
      requireGitLabConnectionConfig({
        GITLAB_TOKEN: "token",
      }),
    ).toThrow("GITLAB_URL");
  });

  it("rejects a malformed GitLab URL before making a request", () => {
    expect(() =>
      requireGitLabConnectionConfig({
        GITLAB_URL: "not-a-url",
        GITLAB_TOKEN: "token",
      }),
    ).toThrow("GITLAB_URL must be a valid http(s) URL");
  });

  it("reads invalid discussion usernames from configuration", () => {
    expect(
      requireGitLabConnectionConfig({
        GITLAB_URL: "https://gitlab.example.test",
        GITLAB_TOKEN: "token",
        GITLAB_INVALID_COMMENT_USERS:
          "jenkinspusher, JenkinsPuller, jenkinspusher, ",
      }),
    ).toMatchObject({
      invalidCommentUsers: ["jenkinspusher", "jenkinspuller"],
    });
  });

  it("lists projects available to the authenticated user", async () => {
    const projects = [
      { id: 42, name: "Billing", path_with_namespace: "team/billing" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(projects), { status: 200 }),
      );
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listProjects()).resolves.toEqual(projects);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "secret" }),
      }),
    );
  });

  it("lists the requested number of recently updated merge requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ iid: 12 }]), { status: 200 }),
      );
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listRecentMergeRequests(7)).resolves.toEqual([
      { iid: 12 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=7",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "secret" }),
      }),
    );
  });

  it("gets canonical project metadata using an encoded namespace path", async () => {
    const project = {
      id: 42,
      name: "Billing Service",
      path_with_namespace: "team/billing-service",
      web_url: "https://gitlab.example.test/team/billing-service",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(project), { status: 200 }),
      );
    const client = new GitLabClient(
      { ...config, project: "team/billing-service" },
      fetchMock,
    );

    await expect(client.getProject()).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects/team%2Fbilling-service",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "secret" }),
      }),
    );
  });

  it("gets canonical project metadata using a numeric project ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, name: "Billing" }), {
        status: 200,
      }),
    );
    const client = new GitLabClient({ ...config, project: "42" }, fetchMock);

    await client.getProject();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects/42",
      expect.anything(),
    );
  });

  it("surfaces failed project metadata requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      );
    const client = new GitLabClient(config, fetchMock);

    await expect(client.getProject()).rejects.toThrow(
      "GitLab request failed (403 Forbidden)",
    );
  });

  it("classifies unreachable GitLab as a network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const client = new GitLabClient(config, fetchMock);

    await expect(client.getProject()).rejects.toMatchObject({
      service: "gitlab",
      kind: "network",
    });
  });

  it("rejects a successful but incompatible GitLab response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "nope" })));
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listRecentMergeRequests(1)).rejects.toMatchObject({
      service: "gitlab",
      kind: "incompatible-response",
    });
  });

  it("follows GitLab pagination when retrieving discussions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "first",
              notes: [
                {
                  body: "Please rename this.",
                  author: { username: "reviewer" },
                  position: { new_path: "src/index.ts", new_line: 9 },
                },
              ],
            },
          ]),
          {
            status: 200,
            headers: { "x-next-page": "2" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "second",
              notes: [
                {
                  body: "Looks good.",
                  author: { username: "reviewer" },
                  position: { old_path: "src/removed.ts", old_line: 3 },
                },
              ],
            },
          ]),
          {
            status: 200,
            headers: { "x-next-page": "" },
          },
        ),
      );
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listMergeRequestDiscussions(12)).resolves.toEqual([
      {
        line: 9,
        comments: ["Please rename this."],
        filePath: "src/index.ts",
      },
      {
        line: 3,
        comments: ["Looks good."],
        filePath: "src/removed.ts",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes configured invalid-user notes from compact discussions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "mixed",
            notes: [
              {
                body: "Automated status",
                author: { username: "JenkinsPusher" },
                position: { new_path: "src/job.ts", new_line: 12 },
              },
              {
                body: "Please retry this job.",
                author: { username: "alex" },
              },
              {
                body: "Automated update",
                author: { username: "jenkinspuller" },
              },
            ],
          },
          {
            id: "automation-only",
            notes: [
              {
                body: "Automated status",
                author: { username: "jenkinspusher" },
              },
            ],
          },
        ]),
      ),
    );
    const client = new GitLabClient(
      {
        ...config,
        invalidCommentUsers: ["jenkinspusher", "jenkinspuller"],
      },
      fetchMock,
    );

    await expect(client.listMergeRequestDiscussions(12)).resolves.toEqual([
      {
        line: 12,
        comments: ["Please retry this job."],
        filePath: "src/job.ts",
      },
    ]);
  });
});

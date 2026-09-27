import { describe, expect, it, vi } from "vitest";

import { GitLabClient, requireGitLabConfig } from "../src/gitlab/client.js";

const config = {
  baseUrl: "https://gitlab.example.test",
  token: "secret",
  project: "team/service",
};

describe("GitLabClient", () => {
  it("rejects incomplete GitLab configuration", () => {
    expect(() =>
      requireGitLabConfig({
        GITLAB_TOKEN: "token",
        GITLAB_PROJECT: "team/service",
      }),
    ).toThrow("GITLAB_URL");
  });

  it("rejects a malformed GitLab URL before making a request", () => {
    expect(() =>
      requireGitLabConfig({
        GITLAB_URL: "not-a-url",
        GITLAB_TOKEN: "token",
        GITLAB_PROJECT: "team/service",
      }),
    ).toThrow("GITLAB_URL must be a valid http(s) URL");
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
        new Response(JSON.stringify([{ id: "first" }]), {
          status: 200,
          headers: { "x-next-page": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "second" }]), {
          status: 200,
          headers: { "x-next-page": "" },
        }),
      );
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listMergeRequestDiscussions(12)).resolves.toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";

import { GitLabClient, requireGitLabConfig } from "../src/gitlab.js";

const config = { baseUrl: "https://gitlab.example.test", token: "secret", project: "team/service" };

describe("GitLabClient", () => {
  it("rejects incomplete GitLab configuration", () => {
    expect(() => requireGitLabConfig({ GITLAB_TOKEN: "token", GITLAB_PROJECT: "team/service" }))
      .toThrow("GITLAB_URL");
  });

  it("lists the requested number of recently updated merge requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ iid: 12 }]), { status: 200 }));
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listRecentMergeRequests(7)).resolves.toEqual([{ iid: 12 }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=7",
      expect.objectContaining({ headers: expect.objectContaining({ "PRIVATE-TOKEN": "secret" }) }),
    );
  });

  it("follows GitLab pagination when retrieving discussions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "first" }]), { status: 200, headers: { "x-next-page": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "second" }]), { status: 200, headers: { "x-next-page": "" } }));
    const client = new GitLabClient(config, fetchMock);

    await expect(client.listMergeRequestDiscussions(12)).resolves.toEqual([{ id: "first" }, { id: "second" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

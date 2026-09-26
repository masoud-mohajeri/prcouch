import { describe, expect, it, vi } from "vitest";

import { CommentService } from "../src/comments.js";
import { GitLabClient } from "../src/gitlab.js";

const config = {
  baseUrl: "https://gitlab.example.test",
  token: "secret",
  project: "team/service",
};
const project = {
  id: 7,
  name: "Service",
  path_with_namespace: "team/service",
  web_url: "https://gitlab.example.test/team/service",
};
const mergeRequests = [
  {
    id: 10,
    iid: 10,
    title: "First change",
    state: "merged",
    web_url: "https://gitlab.example.test/team/service/-/merge_requests/10",
  },
  {
    id: 11,
    iid: 11,
    title: "Second change",
    state: "opened",
    web_url: "https://gitlab.example.test/team/service/-/merge_requests/11",
  },
];

function createService() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/projects/team%2Fservice")) return json(project);
    if (url.pathname.endsWith("/merge_requests")) return json(mergeRequests);
    if (url.pathname.endsWith("/merge_requests/10"))
      return json(mergeRequests[0]);
    if (url.pathname.endsWith("/merge_requests/11"))
      return json(mergeRequests[1]);
    if (url.pathname.endsWith("/merge_requests/10/discussions")) {
      return json([
        {
          id: "discussion-10",
          individual_note: false,
          notes: [
            note({
              id: 1,
              body: "System event",
              system: true,
              author: { name: "GitLab", username: "gitlab" },
            }),
            note({
              id: 2,
              body: "Please validate this input.",
              author: { name: "Jordan Lee", username: "jordan" },
              created_at: "2026-01-02T12:00:00.000Z",
              position: {
                old_path: "src/input.ts",
                new_path: "src/input.ts",
                old_line: 4,
                new_line: 7,
                base_sha: "base-sha",
                head_sha: "head-sha",
              },
            }),
            note({
              id: 3,
              body: "Already fixed.",
              author: { name: "Mira", username: "mira" },
              created_at: "2026-01-02T11:00:00.000Z",
              resolved: true,
            }),
          ],
        },
      ]);
    }
    if (url.pathname.endsWith("/merge_requests/11/discussions")) {
      return json([
        {
          id: "discussion-11",
          individual_note: true,
          notes: [
            note({
              id: 4,
              body: "This deletion needs a migration note.",
              author: { name: "Jordan Lee", username: "jlee" },
              created_at: "2026-01-03T09:00:00.000Z",
              position: {
                old_path: "src/legacy.ts",
                old_line: 18,
                base_sha: "delete-base-sha",
              },
            }),
          ],
        },
      ]);
    }
    return new Response("Not found", { status: 404, statusText: "Not Found" });
  });

  return {
    service: new CommentService(new GitLabClient(config, fetchMock)),
    fetchMock,
  };
}

function note(overrides: Record<string, unknown>) {
  return {
    id: 99,
    body: "Comment",
    author: { name: "Ava", username: "ava" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    system: false,
    resolvable: true,
    resolved: false,
    ...overrides,
  };
}

function query(overrides: Partial<Parameters<CommentService["list"]>[0]> = {}) {
  return {
    state: "all" as const,
    includeResolved: true,
    limit: 25,
    ...overrides,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CommentService", () => {
  it("normalizes human comments and filters authors case-insensitively", async () => {
    const { service } = createService();

    const page = await service.list(query({ authorName: "JORD" }));

    expect(page.project).toEqual(project);
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.noteId)).toEqual([4, 2]);
    expect(page.items[1]).toMatchObject({
      discussionId: "discussion-10",
      author: { name: "Jordan Lee", username: "jordan" },
      mergeRequest: { iid: 10, title: "First change", state: "merged" },
      location: {
        oldPath: "src/input.ts",
        newPath: "src/input.ts",
        oldLine: 4,
        newLine: 7,
      },
      commitSha: "head-sha",
    });
    expect(page.items[1].discussionHistory.map((note) => note.noteId)).toEqual([
      1, 3, 2,
    ]);
    expect(page.items[1].discussionHistory).toContainEqual(
      expect.objectContaining({
        noteId: 1,
        body: "System event",
        system: true,
      }),
    );
    expect(page.items[0].location).toEqual({
      oldPath: "src/legacy.ts",
      newPath: null,
      oldLine: 18,
      newLine: null,
    });
    expect(page.items[0].commitSha).toBe("delete-base-sha");
  });

  it("excludes system and resolved notes when requested, then paginates stable results", async () => {
    const { service } = createService();

    const first = await service.list(
      query({ includeResolved: false, limit: 1 }),
    );
    const second = await service.list(
      query({ includeResolved: false, limit: 1, cursor: first.nextCursor! }),
    );

    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.noteId)).toEqual([4]);
    expect(first.nextCursor).toBe("1");
    expect(second.items.map((item) => item.noteId)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
  });

  it("uses explicit null location and commit fields for non-inline comments", async () => {
    const { service } = createService();

    const page = await service.list(query({ authorName: "mira" }));

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      noteId: 3,
      location: { oldPath: null, newPath: null, oldLine: null, newLine: null },
      commitSha: null,
    });
  });

  it("filters by date and retrieves a specifically requested merge request directly", async () => {
    const { service, fetchMock } = createService();

    const page = await service.list(
      query({
        mergeRequestIid: 10,
        createdAfter: "2026-01-02T11:30:00.000Z",
        createdBefore: "2026-01-02T12:30:00.000Z",
      }),
    );

    expect(page.items.map((item) => item.noteId)).toEqual([2]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests/10",
      expect.anything(),
    );
  });

  it("rejects malformed cursors and inverted date filters", async () => {
    const { service } = createService();

    await expect(
      service.list(query({ cursor: "not-a-cursor" })),
    ).rejects.toThrow("cursor must be a non-negative integer string");
    await expect(
      service.list(
        query({
          createdAfter: "2026-01-03T00:00:00.000Z",
          createdBefore: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("createdAfter must be before or equal to createdBefore");
  });

  it("surfaces GitLab API failures while loading discussions", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/projects/team%2Fservice"))
        return json(project);
      if (url.pathname.endsWith("/merge_requests"))
        return json([mergeRequests[0]]);
      return new Response("Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });
    const service = new CommentService(new GitLabClient(config, fetchMock));

    await expect(service.list(query())).rejects.toThrow(
      "GitLab request failed (503 Service Unavailable)",
    );
  });
});

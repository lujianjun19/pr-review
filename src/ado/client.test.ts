import { test } from "node:test";
import assert from "node:assert/strict";
import { AdoClient } from "./client.ts";

process.env.AZURE_DEVOPS_EXT_PAT = "test-token";

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("ADO client reads pull request statuses from the repository endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return response({
      value: [{ id: 1, state: "succeeded", context: { genre: "ci", name: "build" } }],
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new AdoClient({ org: "contoso", project: "Operations Platform", repo: "portal-api" });
  const statuses = await client.listPullRequestStatuses(42);
  assert.equal(statuses[0].state, "succeeded");
  assert.match(urls[0], /repositories\/portal-api\/pullRequests\/42\/statuses\?api-version=7\.1/);
});

test("ADO client builds the policy artifact id with the project id and PR id", async (t) => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return response({
      value: [
        {
          evaluationId: "eval-1",
          status: "approved",
          configuration: { isBlocking: true, type: { displayName: "Build" } },
        },
      ],
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new AdoClient({ org: "contoso", project: "Operations Platform", repo: "portal-api" });
  const policies = await client.listPolicyEvaluations(42, "project-guid");
  assert.equal(policies[0].status, "approved");
  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/contoso/Operations%20Platform/_apis/policy/evaluations");
  assert.equal(
    url.searchParams.get("artifactId"),
    "vstfs:///CodeReview/CodeReviewId/project-guid/42",
  );
  assert.equal(url.searchParams.get("api-version"), "7.1-preview.1");
});

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

test("ADO client reads linked work items and omits inaccessible ones", async (t) => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/workitems?ids=")) {
      return response({
        value: [
          { id: 101, fields: { "System.Title": "Block empty checkout", "System.WorkItemType": "User Story" } },
          null,
        ],
      });
    }
    return response({ value: [{ id: "101", url: "x" }, { id: "102", url: "y" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new AdoClient({ org: "contoso", project: "Operations Platform", repo: "portal-api" });
  const ids = await client.listPullRequestWorkItemIds(42);
  assert.deepEqual(ids, [101, 102]);
  assert.match(urls[0], /repositories\/portal-api\/pullRequests\/42\/workitems\?api-version=7\.1/);

  const items = await client.getWorkItems(ids);
  assert.equal(items.length, 1);
  assert.equal(items[0].fields?.["System.Title"], "Block empty checkout");
  const url = new URL(urls[1]);
  assert.equal(url.pathname, "/contoso/Operations%20Platform/_apis/wit/workitems");
  assert.equal(url.searchParams.get("ids"), "101,102");
  assert.equal(url.searchParams.get("errorPolicy"), "Omit");
  assert.match(url.searchParams.get("fields") ?? "", /Microsoft\.VSTS\.Common\.AcceptanceCriteria/);

  assert.deepEqual(await client.getWorkItems([]), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrUrl, parseRemoteUrl, remoteUrlFor, webUrlFor } from "./url.ts";

test("parsePrUrl reads the legacy visualstudio.com form and decodes the project", () => {
  assert.deepEqual(
    parsePrUrl("https://contoso.visualstudio.com/Operations%20Platform/_git/portal-api/pullrequest/42"),
    { org: "contoso", project: "Operations Platform", repo: "portal-api", prId: 42 },
  );
});

test("parsePrUrl reads the modern dev.azure.com form", () => {
  assert.deepEqual(
    parsePrUrl("https://dev.azure.com/contoso/Platform/_git/api/pullrequest/42"),
    { org: "contoso", project: "Platform", repo: "api", prId: 42 },
  );
});

test("parsePrUrl drops the legacy DefaultCollection segment", () => {
  // Clone URLs of older accounts carry the collection name. It is not part of
  // the project path the REST API expects, and keeping it 404s every call.
  assert.deepEqual(
    parseRemoteUrl("https://contoso.visualstudio.com/DefaultCollection/Operations%20Platform/_git/portal-api"),
    { org: "contoso", project: "Operations Platform", repo: "portal-api" },
  );
  assert.deepEqual(
    parseRemoteUrl("https://dev.azure.com/contoso/DefaultCollection/Platform/_git/api"),
    { org: "contoso", project: "Platform", repo: "api" },
  );
});

test("parsePrUrl tolerates query strings and a missing pull request id", () => {
  assert.deepEqual(parsePrUrl("https://dev.azure.com/contoso/Platform/_git/api/pullrequest/7?_a=files"), {
    org: "contoso",
    project: "Platform",
    repo: "api",
    prId: 7,
  });
  assert.deepEqual(parsePrUrl("https://dev.azure.com/contoso/Platform/_git/api"), {
    org: "contoso",
    project: "Platform",
    repo: "api",
    prId: undefined,
  });
});

test("parseRemoteUrl reads ssh remotes and strips the .git suffix", () => {
  assert.deepEqual(parseRemoteUrl("git@ssh.dev.azure.com:v3/contoso/Operations Platform/portal-api"), {
    org: "contoso",
    project: "Operations Platform",
    repo: "portal-api",
  });
  assert.deepEqual(parseRemoteUrl("https://contoso@dev.azure.com/contoso/Platform/_git/api.git"), {
    org: "contoso",
    project: "Platform",
    repo: "api",
  });
});

test("unrelated hosts are rejected rather than guessed at", () => {
  assert.equal(parsePrUrl("https://github.com/owner/repo/pull/1"), undefined);
  assert.equal(parsePrUrl("not a url"), undefined);
  assert.equal(parseRemoteUrl("git@github.com:owner/repo.git"), undefined);
});

test("round trip: a parsed remote rebuilds a usable clone and web url", () => {
  const target = parseRemoteUrl(
    "https://contoso.visualstudio.com/DefaultCollection/Operations%20Platform/_git/portal-api",
  )!;
  assert.equal(
    remoteUrlFor(target),
    "https://dev.azure.com/contoso/Operations%20Platform/_git/portal-api",
  );
  assert.equal(
    webUrlFor(target, 9),
    "https://dev.azure.com/contoso/Operations%20Platform/_git/portal-api/pullrequest/9",
  );
});

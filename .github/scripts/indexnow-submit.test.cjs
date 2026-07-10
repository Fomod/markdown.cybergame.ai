const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  canonicalUrlToIndexPath,
  parseNameStatusZ,
  pathToCanonicalUrl,
  pickPreviousSuccessfulHead,
  selectChangedUrls,
  validateConfig,
  waitForPublication,
} = require("./indexnow-submit.cjs");

const host = "markdown.cybergame.ai";
const site = `https://${host}`;

function response(status, body = "") {
  const bytes = Buffer.from(body);
  return {
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("maps only canonical index files to public URLs", () => {
  assert.equal(pathToCanonicalUrl("index.html", host), `${site}/`);
  assert.equal(pathToCanonicalUrl("ko/articles/open-file/index.html", host), `${site}/ko/articles/open-file/`);
  assert.equal(pathToCanonicalUrl("404.html", host), null);
  assert.equal(pathToCanonicalUrl("assets/site.css", host), null);
  assert.equal(canonicalUrlToIndexPath(`${site}/ko/articles/open-file/`, host), "ko/articles/open-file/index.html");
  assert.equal(canonicalUrlToIndexPath("https://example.com/", host), null);
});

test("parses modified, deleted, and renamed paths from null-delimited git output", () => {
  const raw = Buffer.from([
    "M", "articles/changed/index.html",
    "D", "articles/deleted/index.html",
    "R100", "articles/old/index.html", "articles/new/index.html",
    "",
  ].join("\0"));

  assert.deepEqual(parseNameStatusZ(raw), [
    { status: "M", path: "articles/changed/index.html" },
    { status: "D", path: "articles/deleted/index.html" },
    { status: "R", oldPath: "articles/old/index.html", path: "articles/new/index.html" },
  ]);
});

test("uses the latest completed IndexNow run as the no-gap change baseline", () => {
  const currentRunId = "900";
  const previousHead = "a".repeat(40);
  assert.equal(pickPreviousSuccessfulHead([
    { id: 900, status: "completed", conclusion: "success", head_sha: "b".repeat(40) },
    { id: 899, status: "completed", conclusion: "failure", head_sha: "c".repeat(40) },
    { id: 898, status: "completed", conclusion: "success", head_sha: previousHead },
  ], currentRunId), previousHead);
});

test("submits only changed indexable URLs, including removals and config deltas", () => {
  const currentUrls = new Set([
    `${site}/articles/changed/`,
    `${site}/articles/new/`,
    `${site}/articles/config-added/`,
  ]);
  const previousUrls = new Set([
    `${site}/articles/changed/`,
    `${site}/articles/deleted/`,
    `${site}/articles/old/`,
    `${site}/articles/config-removed/`,
    "https://example.com/injected/",
  ]);
  const changes = [
    { status: "M", path: "articles/changed/index.html" },
    { status: "M", path: "assets/site.css" },
    { status: "M", path: "answers.json" },
    { status: "D", path: "articles/deleted/index.html" },
    { status: "R", oldPath: "articles/old/index.html", path: "articles/new/index.html" },
  ];

  assert.deepEqual(selectChangedUrls({ host, changes, currentUrls, previousUrls }), [
    `${site}/articles/changed/`,
    `${site}/articles/config-added/`,
    `${site}/articles/config-removed/`,
    `${site}/articles/deleted/`,
    `${site}/articles/new/`,
    `${site}/articles/old/`,
  ]);
});

test("rejects cross-host, insecure, and malformed IndexNow configuration", () => {
  const valid = {
    endpoint: "https://api.indexnow.org/indexnow",
    host,
    key: "a".repeat(32),
    keyLocation: `${site}/${"a".repeat(32)}.txt`,
    urlList: [`${site}/`],
  };
  assert.doesNotThrow(() => validateConfig(valid));
  assert.throws(() => validateConfig({ ...valid, endpoint: "https://example.com/collect" }), /endpoint/);
  assert.throws(() => validateConfig({ ...valid, urlList: ["http://markdown.cybergame.ai/"] }), /HTTPS/);
  assert.throws(() => validateConfig({ ...valid, urlList: ["https://example.com/"] }), /host/);
});

test("waits until live content bytes match the checked-out page", async () => {
  let attempts = 0;
  await waitForPublication({
    probe: { type: "content", url: `${site}/articles/changed/`, expectedBody: Buffer.from("new") },
    fetchFn: async () => {
      attempts += 1;
      return response(200, attempts === 1 ? "old" : "new");
    },
    sleepFn: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 100,
  });
  assert.equal(attempts, 2);
});

test("waits for a removed URL to return a real 404", async () => {
  let attempts = 0;
  await waitForPublication({
    probe: { type: "deleted", url: `${site}/articles/deleted/` },
    fetchFn: async () => {
      attempts += 1;
      return response(attempts === 1 ? 200 : 404);
    },
    sleepFn: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 100,
  });
  assert.equal(attempts, 2);
});

test("workflow uses changed mode, publication polling, and an explicit full fallback", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/indexnow.yml"), "utf8");
  assert.doesNotMatch(workflow, /sleep\s+180/);
  assert.match(workflow, /submission_mode/);
  assert.match(workflow, /changed/);
  assert.match(workflow, /full/);
  assert.match(workflow, /indexnow-submit\.cjs/);
  assert.match(workflow, /fetch-depth:\s*2/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /GITHUB_TOKEN/);
});

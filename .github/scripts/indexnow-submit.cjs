const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = "indexnow-urls.json";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10000;

function pathToCanonicalUrl(filePath, host) {
  const normalized = String(filePath).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  if (normalized !== "index.html" && !normalized.endsWith("/index.html")) return null;
  const route = normalized === "index.html" ? "/" : `/${normalized.slice(0, -"index.html".length)}`;
  return new URL(route, `https://${host}`).toString();
}

function canonicalUrlToIndexPath(value, host) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.search || url.hash) return null;
  if (!url.pathname.endsWith("/")) return null;
  const route = url.pathname.replace(/^\/+/, "");
  if (route.split("/").includes("..")) return null;
  return route ? `${route}index.html` : "index.html";
}

function parseNameStatusZ(raw) {
  const tokens = Buffer.isBuffer(raw) ? raw.toString("utf8").split("\0") : String(raw).split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    const status = statusToken[0];
    if (!/[ACDMRTUXB]/.test(status)) throw new Error(`Unsupported git diff status: ${statusToken}`);
    if (status === "R" || status === "C") {
      const oldPath = tokens[index++];
      const filePath = tokens[index++];
      if (!oldPath || !filePath) throw new Error(`Incomplete ${statusToken} git diff record`);
      changes.push({ status, oldPath, path: filePath });
    } else {
      const filePath = tokens[index++];
      if (!filePath) throw new Error(`Incomplete ${statusToken} git diff record`);
      changes.push({ status, path: filePath });
    }
  }
  return changes;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("IndexNow config must be an object");
  if (!/^[a-z0-9.-]+$/i.test(config.host || "")) throw new Error("IndexNow config has an invalid host");
  if (config.endpoint !== INDEXNOW_ENDPOINT) throw new Error(`IndexNow endpoint must be ${INDEXNOW_ENDPOINT}`);
  if (!/^[a-z0-9-]{8,128}$/i.test(config.key || "")) throw new Error("IndexNow config has an invalid key");

  let keyLocation;
  try {
    keyLocation = new URL(config.keyLocation);
  } catch {
    throw new Error("IndexNow keyLocation must be a valid URL");
  }
  if (keyLocation.protocol !== "https:") throw new Error("IndexNow keyLocation must use HTTPS");
  if (keyLocation.hostname !== config.host || keyLocation.port) throw new Error("IndexNow keyLocation must stay on the configured host");
  if (!keyLocation.pathname.endsWith(`/${config.key}.txt`)) throw new Error("IndexNow keyLocation must point to the public key file");

  if (!Array.isArray(config.urlList)) throw new Error("IndexNow urlList must be an array");
  if (config.urlList.length > MAX_URLS) throw new Error(`IndexNow urlList exceeds ${MAX_URLS} URLs`);
  const seen = new Set();
  for (const value of config.urlList) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`IndexNow urlList contains an invalid URL: ${value}`);
    }
    if (url.protocol !== "https:") throw new Error(`IndexNow URLs must use HTTPS: ${value}`);
    if (url.hostname !== config.host || url.port) throw new Error(`IndexNow URL must stay on host ${config.host}: ${value}`);
    if (url.username || url.password || url.search || url.hash) throw new Error(`IndexNow URL must be canonical: ${value}`);
    if (seen.has(value)) throw new Error(`IndexNow urlList contains a duplicate: ${value}`);
    seen.add(value);
  }
  return config;
}

function selectChangedUrls({ host, changes, currentUrls, previousUrls }) {
  const selected = new Set();
  const addCanonicalUrl = (url) => {
    if (canonicalUrlToIndexPath(url, host)) selected.add(url);
  };
  const addWhenAllowed = (filePath, allowedUrls) => {
    const url = pathToCanonicalUrl(filePath, host);
    if (url && allowedUrls.has(url)) addCanonicalUrl(url);
  };

  for (const change of changes) {
    if (change.status === "D") {
      addWhenAllowed(change.path, previousUrls);
      continue;
    }
    if (change.status === "R" || change.status === "C") {
      addWhenAllowed(change.oldPath, previousUrls);
      addWhenAllowed(change.path, currentUrls);
      continue;
    }
    addWhenAllowed(change.path, currentUrls);
  }

  for (const url of currentUrls) if (!previousUrls.has(url)) addCanonicalUrl(url);
  for (const url of previousUrls) if (!currentUrls.has(url)) addCanonicalUrl(url);
  return [...selected].sort();
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: process.cwd(), ...options });
}

function commitExists(revision) {
  try {
    git(["cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureCommit(revision) {
  if (commitExists(revision)) return;
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`Cannot fetch unsafe git revision: ${revision}`);
  console.log(`Fetching push base ${revision.slice(0, 12)} for changed-URL detection`);
  git(["fetch", "--no-tags", "--depth=1", "origin", revision], { stdio: "inherit" });
  if (!commitExists(revision)) throw new Error(`Push base ${revision} is unavailable after fetch`);
}

function readConfigAt(revision) {
  try {
    const raw = git(["show", `${revision}:${CONFIG_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function diffChanges(baseRevision, headRevision) {
  const args = baseRevision
    ? ["diff", "--name-status", "-z", "--find-renames", baseRevision, headRevision]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", headRevision];
  return parseNameStatusZ(git(args));
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function choosePublicationProbe({ changedUrls, changes, currentUrls, host, cwd = process.cwd() }) {
  const directlyChanged = new Set();
  for (const change of changes) {
    if (change.status !== "D") {
      const url = pathToCanonicalUrl(change.path, host);
      if (url) directlyChanged.add(url);
    }
  }

  const currentCandidates = changedUrls
    .filter((url) => currentUrls.has(url))
    .sort((left, right) => Number(directlyChanged.has(right)) - Number(directlyChanged.has(left)) || left.localeCompare(right));
  for (const url of currentCandidates) {
    const indexPath = canonicalUrlToIndexPath(url, host);
    if (!indexPath) continue;
    const absolutePath = path.join(cwd, indexPath);
    if (!fs.existsSync(absolutePath)) continue;
    return { type: "content", url, expectedBody: fs.readFileSync(absolutePath), indexPath };
  }

  const deletedUrl = changedUrls.find((url) => !currentUrls.has(url));
  if (deletedUrl) return { type: "deleted", url: deletedUrl };
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pickPreviousSuccessfulHead(runs, currentRunId) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.status !== "completed" || run.conclusion !== "success") continue;
    if (/^[0-9a-f]{40}$/i.test(run.head_sha || "")) return run.head_sha;
  }
  return null;
}

async function findPreviousSuccessfulHead(fetchFn = fetchWithTimeout) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error("GITHUB_REPOSITORY has an invalid format");

  const endpoint = new URL(`https://api.github.com/repos/${repository}/actions/workflows/indexnow.yml/runs`);
  endpoint.searchParams.set("branch", "main");
  endpoint.searchParams.set("status", "success");
  endpoint.searchParams.set("per_page", "100");
  try {
    const response = await fetchFn(endpoint, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status !== 200) {
      console.log(`Could not read prior IndexNow runs (HTTP ${response.status}); using the push base`);
      return null;
    }
    const body = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
    const head = pickPreviousSuccessfulHead(body.workflow_runs, process.env.GITHUB_RUN_ID);
    if (head) console.log(`Using last successful IndexNow run ${head.slice(0, 12)} as the no-gap change baseline`);
    return head;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Could not read prior IndexNow runs (${message}); using the push base`);
    return null;
  }
}

async function waitForPublication({
  probe,
  fetchFn = fetchWithTimeout,
  sleepFn = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
}) {
  if (!probe) return;
  const startedAt = Date.now();
  const expectedHash = probe.type === "content" ? sha256(probe.expectedBody) : null;
  let attempts = 0;
  let lastState = "not checked";

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const target = new URL(probe.url);
    target.searchParams.set("__indexnow_deploy", `${process.env.GITHUB_SHA || "local"}-${attempts}`);
    try {
      const response = await fetchFn(target, {
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        redirect: "manual",
      });
      if (probe.type === "deleted") {
        lastState = `HTTP ${response.status}`;
        if (response.status === 404) {
          console.log(`Publication confirmed after ${attempts} check(s): ${probe.url} returns 404`);
          return;
        }
      } else {
        const body = Buffer.from(await response.arrayBuffer());
        const liveHash = sha256(body);
        lastState = `HTTP ${response.status}, sha256 ${liveHash.slice(0, 12)}`;
        if (response.status === 200 && liveHash === expectedHash) {
          console.log(`Publication confirmed after ${attempts} check(s): ${probe.url} matches ${expectedHash.slice(0, 12)}`);
          return;
        }
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }

    if (attempts === 1 || attempts % 6 === 0) {
      console.log(`Waiting for Pages publication (${attempts} checks; last state: ${lastState})`);
    }
    await sleepFn(pollIntervalMs);
  }
  throw new Error(`Pages publication was not confirmed within ${timeoutMs}ms for ${probe.url}; last state: ${lastState}`);
}

function appendSummary({ mode, changedFileCount, urlCount, publicationProbe, result }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "### IndexNow notification",
    `- Mode: ${mode}`,
    `- Changed files inspected: ${changedFileCount}`,
    `- URLs selected: ${urlCount}`,
    `- Publication probe: ${publicationProbe ? publicationProbe.url : "not required"}`,
    `- Result: ${result}`,
    "",
  ];
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

async function submitIndexNow(config, urlList) {
  const payload = {
    host: config.host,
    key: config.key,
    keyLocation: config.keyLocation,
    urlList,
  };
  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  await response.arrayBuffer();
  console.log(`IndexNow response: ${response.status} ${response.statusText || ""}`.trim());
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow submission failed with HTTP ${response.status}`);
}

async function main() {
  const config = validateConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  const mode = process.env.INDEXNOW_MODE || "changed";
  if (!new Set(["changed", "full"]).has(mode)) throw new Error(`Unsupported INDEXNOW_MODE: ${mode}`);

  let changes = [];
  let urlList;
  let publicationProbe = null;
  if (mode === "full") {
    urlList = [...config.urlList];
  } else {
    const headRevision = process.env.INDEXNOW_HEAD_SHA || process.env.GITHUB_SHA || "HEAD";
    const successfulHead = await findPreviousSuccessfulHead();
    let baseRevision = successfulHead || process.env.INDEXNOW_BASE_SHA || "HEAD^";
    if (/^0{40}$/.test(baseRevision)) baseRevision = null;
    if (baseRevision) ensureCommit(baseRevision);
    ensureCommit(headRevision);

    const previousConfig = baseRevision ? readConfigAt(baseRevision) : null;
    const previousUrls = new Set(Array.isArray(previousConfig?.urlList) ? previousConfig.urlList : []);
    const currentUrls = new Set(config.urlList);
    changes = diffChanges(baseRevision, headRevision);
    urlList = selectChangedUrls({ host: config.host, changes, currentUrls, previousUrls });
    publicationProbe = choosePublicationProbe({ changedUrls: urlList, changes, currentUrls, host: config.host });
  }

  if (urlList.length > MAX_URLS) throw new Error(`IndexNow selection has ${urlList.length} URLs; split before submitting`);
  console.log(`Prepared ${urlList.length} ${mode} URL(s) for ${config.host} from ${changes.length} changed file(s)`);
  if (!urlList.length) {
    appendSummary({ mode, changedFileCount: changes.length, urlCount: 0, publicationProbe, result: "skipped; no changed indexable URLs" });
    console.log("No changed indexable URLs; skipping IndexNow notification");
    return;
  }

  if (process.env.INDEXNOW_DRY_RUN === "1") {
    appendSummary({ mode, changedFileCount: changes.length, urlCount: urlList.length, publicationProbe, result: "dry run" });
    console.log(`Dry run: first selected URL is ${urlList[0]}`);
    return;
  }

  if (mode === "changed") await waitForPublication({ probe: publicationProbe });
  await submitIndexNow(config, urlList);
  appendSummary({ mode, changedFileCount: changes.length, urlCount: urlList.length, publicationProbe, result: "submitted" });
  console.log(`Submitted ${urlList.length} URL(s) for ${config.host}`);
}

module.exports = {
  canonicalUrlToIndexPath,
  choosePublicationProbe,
  diffChanges,
  parseNameStatusZ,
  pathToCanonicalUrl,
  pickPreviousSuccessfulHead,
  selectChangedUrls,
  validateConfig,
  waitForPublication,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

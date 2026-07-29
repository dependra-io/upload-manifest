#!/usr/bin/env node
// @dependra/manifest-sync — the glue the composite Action runs, driving the vendored CLI bundle.
//
// Responsibilities (all dependency-light, Node built-ins only — no @actions/* install):
//   1. validate the manifest via the in-repo CLI (imported, not shelled) → GitHub ::error annotations,
//      fail the step on any error-severity issue (respecting `fail-on`).
//   2. bundle the manifest → the self-contained {manifest, docs, hashes} transport package.
//   3. transform the bundle into the tenant-addressed ingest wire shape.
//   4. obtain auth: api-key input (fallback) OR a GitHub OIDC token exchanged at the tenant-addressed
//      token endpoint for a short-lived manifest-sync-scoped Dependra key. The exchanged token/api-key
//      is ALWAYS masked (::add-mask::) so it never lands in a log.
//   5. POST the bundle to the ingest (?dryRun per mode) with a bounded, timeout-guarded retry
//      (ingest is idempotent per releaseSha, so retry is safe).
//   6. surface the returned diff → a PR comment on pull_request, else the job summary.
//
// Mode: an explicit `mode` input always wins. Otherwise APPLY happens ONLY on a `release` event or a
// `push` to the repository's DEFAULT branch; every other trigger (feature-branch push,
// workflow_dispatch, schedule, any PR) is a DRY-RUN — unreviewed content must never write prod.
//
// Resilience: a Dependra outage FAILS SOFT on pull_request (posts "sync unavailable", neutral exit)
// but FAILS HARD on release/push (a broken landscape sync on the mainline must be loud). A fork PR
// (no OIDC, read-only token) also fails soft — the check is neutral and applies on merge. Manifest
// VALIDATION errors always fail HARD, even on a PR.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// GitHub Actions plumbing (workflow commands + files), zero-dependency.
// ---------------------------------------------------------------------------

/** Escape a value for use inside a `::command key=value::` annotation property. */
function escapeProp(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
}
/** Escape the message body of a workflow command. */
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function annotate(level, message, props = {}) {
  const parts = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${escapeProp(v)}`)
    .join(',');
  process.stdout.write(`::${level} ${parts}::${escapeData(message)}\n`);
}

function maskSecret(value) {
  // GitHub masks the LITERAL bytes passed to ::add-mask::. The secret is used raw in the
  // Authorization header, so we must register the RAW value (never escapeData'd) — otherwise a
  // secret containing %, \r or \n would register a mask that never matches and would leak.
  // Strip only a trailing newline (which the command's own terminator would otherwise consume).
  if (value) process.stdout.write(`::add-mask::${String(value).replace(/\r?\n$/, '')}\n`);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  // Heredoc form so multi-line JSON survives intact.
  const delim = `__dependra_${name}_${Math.random().toString(36).slice(2)}__`;
  const line = `${name}<<${delim}\n${v}\n${delim}\n`;
  if (file) fs.appendFileSync(file, line);
}

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, markdown + '\n');
  else process.stdout.write(markdown + '\n');
}

function fail(message) {
  annotate('error', message);
  process.exitCode = 1;
}

function neutralExit(message) {
  // Fail-soft: surface a notice and leave exitCode 0 so a PR check goes green/neutral, not red.
  annotate('notice', message);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Inputs (composite action passes them via INPUT_* env, matching actions/toolkit).
// ---------------------------------------------------------------------------

// The composite action passes inputs via DEP_* env vars (plain POSIX identifiers — hyphenated
// input names can't be exported as shell env vars).
const INPUT_ENV = {
  'manifest': 'DEP_MANIFEST',
  'dependra-url': 'DEP_URL',
  'tenant-id': 'DEP_TENANT_ID',
  'mode': 'DEP_MODE',
  'api-key': 'DEP_API_KEY',
  'audience': 'DEP_AUDIENCE',
  'fail-on': 'DEP_FAIL_ON',
  'allow-pull-request-target': 'DEP_ALLOW_PR_TARGET',
};

function input(name, fallback = '') {
  const envName = INPUT_ENV[name];
  const v = envName ? process.env[envName] : undefined;
  return (v === undefined || v === '') ? fallback : v.trim();
}

// ---------------------------------------------------------------------------
// OIDC + HTTP.
// ---------------------------------------------------------------------------

/**
 * Request a GitHub Actions OIDC JWT for the given audience — the same runtime contract
 * `@actions/core.getIDToken(audience)` uses under the hood (env vars injected when the
 * workflow grants `id-token: write`).
 */
/** True when the runner injected the OIDC request env (workflow granted `id-token: write`). */
function oidcAvailable() {
  return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

async function getIDToken(audience) {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqToken) {
    throw new Error(
      'OIDC is not available. Grant `permissions: id-token: write` in the workflow, or pass an `api-key` input as a fallback.',
    );
  }
  const url = new URL(reqUrl);
  if (audience) url.searchParams.set('audience', audience);
  const res = await fetchWithTimeout(url.toString(), {
    headers: { Authorization: `Bearer ${reqToken}`, 'Content-Type': 'application/json' },
  }, 15_000);
  if (!res.ok) throw new Error(`OIDC token request failed with HTTP ${res.status}.`);
  const body = await res.json();
  if (!body || typeof body.value !== 'string') throw new Error('OIDC token response had no value.');
  return body.value;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** POST JSON with a bounded retry on transient failures (network error / 5xx / 429). Idempotent-safe. */
async function postJsonWithRetry(url, headers, body, { timeoutMs = 30_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }, timeoutMs);
      // Retry only on transient server-side conditions; 4xx (except 429) are terminal client errors.
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`Dependra responded with HTTP ${res.status}.`);
        if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
    }
  }
  throw lastErr ?? new Error('Request failed.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 8000);

/**
 * Exchange a GitHub OIDC token for a Dependra key with a bounded retry that re-fetches a FRESH OIDC token per
 * attempt.
 *
 * Why fresh-per-attempt: the server enforces one-time use per OIDC `jti` (a replay → 409). Reusing the same token
 * across a retry (e.g. after a lost response or a transient 5xx) would trip that guard and fail the run on a benign
 * blip. Because `getIDToken` mints a NEW jti each call, each retry presents a distinct token and can never 409.
 *
 * Retry policy: only transient failures (network error / 5xx) are retried. A 401 (invalid token) or 403 (unbound
 * repo) is TERMINAL — retrying with a new token would neither help nor be safe — so it is returned immediately for
 * the caller to surface. The freshly-minted token is masked before it can hit any log.
 *
 * @param {() => Promise<string>} fetchIdToken  Mints a fresh OIDC JWT (new jti) each call.
 * @param {string} url  The tenant-addressed exchange endpoint.
 */
export async function exchangeOidcWithRetry(fetchIdToken, url, { timeoutMs = 20_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // Fresh token per attempt → distinct jti → a retried exchange can never be refused as a replay.
    const idToken = await fetchIdToken();
    // Defensive: the raw OIDC JWT is a GitHub-issued bearer — mask it before it can hit any log.
    maskSecret(idToken);
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken }),
      }, timeoutMs);
      // Retry ONLY on transient server-side conditions. 2xx and terminal 4xx (401/403/other) return immediately.
      if (res.status >= 500) {
        lastErr = new Error(`Dependra responded with HTTP ${res.status}.`);
        if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
      }
      return res;
    } catch (err) {
      // Network error / timeout / lost response — transient. Retry with a brand-new token.
      lastErr = err;
      if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
    }
  }
  throw lastErr ?? new Error('Token exchange failed.');
}

// ---------------------------------------------------------------------------
// Bundle → ingest wire transform.
//
// The CLI bundle is { manifest (the authoring-dialect object), docs (repo-path-keyed), hashes }.
// The ingest wire shape is { manifest: <JSON STRING>, repo, releaseSha, docs (technicalName-keyed),
// hashes }.
//
// Dependra maps the friendly manifest dialect (id/from/to/type/broker/application/businessDomain)
// onto the landscape at the ingest boundary, so the Action does not rewrite the manifest at all —
// it passes it through verbatim (JSON-stringified).
//
// The one thing done client-side is re-keying referenced doc CONTENT by the owning entity's
// technicalName: Dependra folds a doc into an entity's documentation keyed by technicalName, but the
// CLI bundle keys docs by repo-relative PATH. We read each entity's `documentation` `{file}` ref to
// learn which technicalName the doc belongs to, and emit outDocs[key] = content. The manifest object
// is left untouched.
//
// `description` is an inline STRING ONLY — it never carries a `{file}` ref, so there is nothing to
// re-key for it. `documentation` is the sole rich-text field with a file ref:
//   * documentation → outDocs["documentation:" + technicalName]
// Documentation has a backing column only on applications + components, so we re-key it only for
// those collections.
// ---------------------------------------------------------------------------

// Collections whose entity carries a documentation field (Applications and Components). These are the
// only collections whose `documentation` {file} ref is re-keyed for ingest.
export const DOCUMENTATION_COLLECTIONS = ['applications', 'components'];

// Doc-map key prefix for documentation refs, matched by the ingest side when folding docs onto entities.
export const DOCUMENTATION_KEY_PREFIX = 'documentation:';

export function transformForIngest(bundle, repo, releaseSha) {
  const manifest = bundle.manifest ?? {};
  const outDocs = {};
  const outHashes = {};

  // Build a repo-path → content lookup from the CLI bundle so we can re-key by technicalName.
  const byPath = bundle.docs ?? {};
  const hashByPath = (bundle.hashes && bundle.hashes.docs) ? bundle.hashes.docs : {};

  // Fold one entity `{file}` rich-text ref into outDocs/outHashes under the given map key.
  const foldRef = (ref, docKey) => {
    if (!ref || typeof ref !== 'object' || typeof ref.file !== 'string') return;
    const key = resolveDocKey(byPath, ref);
    if (key && byPath[key] !== undefined) {
      outDocs[docKey] = byPath[key];
      if (hashByPath[key] !== undefined) outHashes[docKey] = hashByPath[key];
    }
  };

  // Only `documentation` {file} refs are re-keyed (description is inline-string only, no file ref).
  for (const coll of DOCUMENTATION_COLLECTIONS) {
    const items = Array.isArray(manifest[coll]) ? manifest[coll] : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      // The manifest keys entities by `id` (with an optional explicit `technicalName`); ingest
      // resolves technicalName then id, so match that ordering when re-keying doc content.
      const tn = typeof item.technicalName === 'string' ? item.technicalName
        : (typeof item.id === 'string' ? item.id : undefined);
      if (!tn) continue;
      // documentation: {file} → fold under the "documentation:"-prefixed key. The manifest itself is NOT mutated.
      foldRef(item.documentation, DOCUMENTATION_KEY_PREFIX + tn);
    }
  }

  return {
    manifest: JSON.stringify(manifest),
    repo,
    releaseSha,
    docs: outDocs,
    hashes: outHashes,
  };
}

/** Match a {file} ref against the bundle's repo-path doc keys. */
export function resolveDocKey(byPath, ref) {
  // The bundle key is a repo-root-relative POSIX path. The manifest ref is relative to its
  // declaring file, so exact-match on the basename tail is the reliable join.
  const base = ref.file.split('/').pop();
  const candidates = Object.keys(byPath).filter((k) => k.split('/').pop() === base);
  return candidates.length === 1 ? candidates[0] : (candidates[0] ?? undefined);
}

// ---------------------------------------------------------------------------
// Diff rendering.
// ---------------------------------------------------------------------------

function renderDiff(result, { mode, dryRun }) {
  const imp = result.import ?? {};
  const lines = [];
  lines.push('### Dependra manifest sync');
  lines.push('');
  lines.push(`- **Mode:** ${dryRun ? 'dry-run (preview)' : 'apply'}`);
  lines.push(`- **Valid:** ${imp.valid ? 'yes' : 'no'}`);
  lines.push(`- **Applied:** ${result.applied ? 'yes' : 'no'}${result.alreadyApplied ? ' (already applied — idempotent replay)' : ''}`);
  if (result.manifestHash) lines.push(`- **Manifest hash:** \`${String(result.manifestHash).slice(0, 12)}…\``);
  lines.push('');
  const errors = Array.isArray(imp.errors) ? imp.errors : [];
  if (errors.length > 0) {
    lines.push('**Validation errors:**');
    lines.push('');
    for (const e of errors.slice(0, 50)) {
      lines.push(`- \`${e.path ?? e.Path ?? '$'}\` — ${e.message ?? e.Message ?? String(e)}`);
    }
    if (errors.length > 50) lines.push(`- …and ${errors.length - 50} more`);
    lines.push('');
  }
  const changes = Array.isArray(imp.changes) ? imp.changes : [];
  if (changes.length > 0) {
    lines.push(`**Changes (${changes.length}):**`);
    lines.push('');
    for (const c of changes.slice(0, 100)) {
      const action = c.action ?? c.Action ?? '?';
      const type = c.entityType ?? c.EntityType ?? '?';
      const key = c.key ?? c.Key ?? '';
      lines.push(`- \`${action}\` ${type} \`${key}\``);
    }
    if (changes.length > 100) lines.push(`- …and ${changes.length - 100} more`);
  } else {
    lines.push('_No changes._');
  }
  return lines.join('\n');
}

const COMMENT_MARKER = '<!-- dependra-manifest-sync -->';

/** Upsert a single PR comment (find-by-marker, else create) via the REST API using GITHUB_TOKEN. */
async function upsertPrComment(markdown) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // owner/name
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const prNumber = readPrNumber();
  if (!token || !repo || !prNumber) {
    // No PR context or token: fall back to the job summary rather than failing the sync.
    writeSummary(markdown);
    return;
  }
  const body = `${COMMENT_MARKER}\n${markdown}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dependra-manifest-sync',
  };
  try {
    const listRes = await fetchWithTimeout(
      `${apiUrl}/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers }, 15_000);
    let existingId;
    if (listRes.ok) {
      const comments = await listRes.json();
      const hit = Array.isArray(comments) ? comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) : undefined;
      existingId = hit?.id;
    }
    if (existingId) {
      await fetchWithTimeout(`${apiUrl}/repos/${repo}/issues/comments/${existingId}`,
        { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }, 15_000);
    } else {
      await fetchWithTimeout(`${apiUrl}/repos/${repo}/issues/${prNumber}/comments`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }, 15_000);
    }
  } catch {
    // Commenting is best-effort — never fail the sync because the comment API hiccupped.
    writeSummary(markdown);
  }
}

function readPrNumber() {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return undefined;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    return event.pull_request?.number ?? event.number ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Mode selection.
// ---------------------------------------------------------------------------

/** Read the repository's default branch from the event payload (repository.default_branch). */
function readDefaultBranch() {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return undefined;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const b = event?.repository?.default_branch;
    return typeof b === 'string' && b ? b : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective mode.
 *
 * An explicit `mode` input always wins. Otherwise we APPLY only when the run is safe to write prod
 * from reviewed content:
 *   * a `release` event, OR
 *   * a `push` to the DEFAULT branch (GITHUB_REF === refs/heads/<default-branch>).
 * Everything else — a push to a feature branch, workflow_dispatch, schedule, or any PR — is a
 * DRY-RUN. This prevents unreviewed content on a side branch (or a manual dispatch) from writing prod.
 */
function resolveMode(explicit, eventName) {
  if (explicit === 'dry-run' || explicit === 'apply') return explicit;
  if (eventName === 'release') return 'apply';
  if (eventName === 'push') {
    const def = readDefaultBranch();
    const ref = process.env.GITHUB_REF || '';
    const refName = process.env.GITHUB_REF_NAME || '';
    // Prefer the fully-qualified ref; fall back to GITHUB_REF_NAME when GITHUB_REF is absent.
    const onDefault = def
      ? (ref === `refs/heads/${def}` || (!ref && refName === def))
      : false;
    if (onDefault) return 'apply';
  }
  return 'dry-run';
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const isPr = eventName === 'pull_request' || eventName === 'pull_request_target';
  const isPrTarget = eventName === 'pull_request_target';

  const manifestPath = input('manifest', '.dependra/manifest.yaml');
  const dependraUrl = (input('dependra-url', 'https://dependra.io') || 'https://dependra.io').replace(/\/+$/, '');
  const tenantId = input('tenant-id');
  const mode = resolveMode(input('mode'), eventName);
  const apiKey = input('api-key');
  const audience = input('audience', 'https://dependra.io');
  const failOn = (input('fail-on', 'error') || 'error').toLowerCase();
  const allowPrTarget = /^(1|true|yes)$/i.test(input('allow-pull-request-target', ''));
  const dryRun = mode === 'dry-run';

  if (!tenantId) return fail('`tenant-id` input is required.');
  if (!fs.existsSync(manifestPath)) return fail(`Manifest not found at "${manifestPath}".`);

  // Import the COMMITTED, pre-built single-file CLI bundle (vendored next to this script). No runtime
  // `npm ci`/build is needed — the Action ships the esbuild bundle + its co-located schema. The bundle is
  // produced by the CLI's release and committed here under vendor/, so the Action is self-contained at
  // runtime with no dependency on any source layout.
  const cliEntry = path.resolve(__dirname, 'vendor', 'manifest-cli.mjs');
  if (!fs.existsSync(cliEntry)) {
    return fail(`The committed CLI bundle was not found at ${cliEntry}. It ships under vendor/ — reinstall the Action at a published version.`);
  }
  const cli = await import(pathToFileURL(cliEntry).href);

  // 1. Validate → annotations.
  let issues;
  try {
    ({ issues } = cli.runValidate(manifestPath));
  } catch (err) {
    return fail(`Failed to load the manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  for (const i of issues) {
    annotate(i.severity === 'error' ? 'error' : 'warning', i.message, {
      file: i.file, line: i.line || undefined, title: `manifest ${i.path}`,
    });
  }
  const failing = failOn === 'warning' ? issues.length > 0 : errors.length > 0;
  if (failing) {
    return fail(`Manifest validation failed: ${errors.length} error(s), ${warnings.length} warning(s). Sync aborted.`);
  }

  // 2. Bundle.
  let bundle;
  try {
    ({ bundle } = cli.runBundle(manifestPath));
  } catch (err) {
    const isss = err && err.issues;
    if (Array.isArray(isss)) {
      for (const i of isss) annotate(i.severity === 'error' ? 'error' : 'warning', i.message, { file: i.file, line: i.line || undefined });
    }
    return fail(`Failed to bundle the manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  const repo = process.env.GITHUB_REPOSITORY || '';
  const releaseSha = process.env.GITHUB_SHA || '';
  const wire = transformForIngest(bundle, repo, releaseSha);

  // 3. Auth: api-key fallback, else OIDC exchange (both masked).
  let token = apiKey;
  if (token) {
    maskSecret(token);
  } else {
    // Fork PRs get no OIDC token (and a read-only GITHUB_TOKEN). Rather than a hard red X — which
    // contradicts the "fail-soft on PR" contract — surface a neutral notice; apply happens on merge.
    if (isPr && !oidcAvailable()) {
      const note = 'Sync unavailable on this PR (no OIDC — fork PRs and read-only tokens cannot mint a Dependra credential). ' +
        'The manifest will apply on merge to the default branch.';
      upsertPrComment(`### Dependra manifest sync\n\n> :information_source: ${note}`).catch(() => {});
      return neutralExit(note);
    }
    // pull_request_target runs in the trusted base context (full secrets, write token) against
    // untrusted PR-head code. Refuse the credential exchange unless the consumer opts in explicitly.
    if (isPrTarget && !allowPrTarget) {
      const note = 'Refusing the OIDC token exchange under `pull_request_target` (base-context secrets vs untrusted PR-head code). ' +
        'Prefer the `pull_request` event. To override, set `allow-pull-request-target: true`.';
      upsertPrComment(`### Dependra manifest sync\n\n> :warning: ${note}`).catch(() => {});
      return neutralExit(note);
    }
    // The server enforces one-time use per OIDC jti (replay guard): a REPLAYED token → 409. So a retried exchange
    // must NOT reuse the same token — each attempt fetches a FRESH OIDC token (a new jti), which also makes a
    // lost-response retry safe (a distinct jti can never 409). We retry only on transient failures (network/5xx),
    // never on a terminal 401 (invalid token) or 403 (unbound repo).
    let exRes;
    try {
      exRes = await exchangeOidcWithRetry(
        () => getIDToken(audience),
        `${dependraUrl}/api/${tenantId}/integrations/github/token`,
        { timeoutMs: 20_000, retries: 3 });
    } catch (err) {
      return handleOutage(isPr, `Token exchange failed to reach Dependra: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (exRes.status === 401) return fail('OIDC token was rejected by Dependra (401). Check the `audience` input matches Dependra\'s configured audience.');
    if (exRes.status === 403) return fail('This repository is not on the target tenant\'s GitHub whitelist (403). A tenant owner must approve it.');
    if (exRes.status >= 500) return handleOutage(isPr, `Token exchange failed with HTTP ${exRes.status}.`);
    if (!exRes.ok) return fail(`Token exchange failed with HTTP ${exRes.status}.`);
    const exBody = await exRes.json();
    token = exBody.token;
    if (!token) return fail('Token exchange succeeded but returned no token.');
    maskSecret(token);
  }

  // 4. Ingest.
  let res;
  try {
    res = await postJsonWithRetry(
      `${dependraUrl}/api/${tenantId}/integrations/manifest-sync?dryRun=${dryRun}`,
      { Authorization: `Bearer ${token}` }, wire,
      { timeoutMs: 60_000, retries: 3 });
  } catch (err) {
    return handleOutage(isPr, `Manifest sync failed to reach Dependra: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 401) return fail('Dependra rejected the sync credential (401).');
  if (res.status === 403) return fail('The credential lacks the manifest-sync scope, or the tenant/route mismatched (403).');
  if (res.status >= 500) return handleOutage(isPr, `Manifest sync failed with HTTP ${res.status}.`);

  let result;
  try {
    result = await res.json();
  } catch {
    return fail(`Dependra returned a non-JSON response (HTTP ${res.status}).`);
  }

  // 5. Surface the diff.
  const markdown = renderDiff(result, { mode, dryRun });
  if (isPr) await upsertPrComment(markdown);
  else writeSummary(markdown);

  setOutput('applied', String(Boolean(result.applied)));
  setOutput('manifest-hash', String(result.manifestHash ?? ''));
  setOutput('diff', markdown);

  // A structurally-invalid manifest is a 400 with valid:false → fail the check (with the annotations above).
  const imp = result.import ?? {};
  if (res.status === 400 || imp.valid === false) {
    const errs = Array.isArray(imp.errors) ? imp.errors : [];
    for (const e of errs) annotate('error', e.message ?? e.Message ?? String(e), { title: `ingest ${e.path ?? e.Path ?? ''}` });
    return fail(`Dependra rejected the manifest: ${errs.length} validation error(s).`);
  }
}

/** Fail soft on PRs (a Dependra outage shouldn't red-X a PR), hard on release/push. */
function handleOutage(isPr, message) {
  if (isPr) {
    // Best-effort: leave a note on the PR and exit neutral.
    upsertPrComment(`### Dependra manifest sync\n\n> :warning: Sync unavailable — ${message}\n> This PR check is neutral; the sync will run on merge.`).catch(() => {});
    return neutralExit(`Dependra sync unavailable (fail-soft on PR): ${message}`);
  }
  return fail(`Dependra sync unavailable: ${message}`);
}

// Run only when invoked as the Action entrypoint (`node sync.mjs`), NOT when imported by a test.
// This keeps the pure transform helpers (transformForIngest/resolveDocKey) importable without side effects.
const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((err) => fail(`Unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`));
}

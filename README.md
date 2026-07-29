# Dependra Manifest Sync — GitHub Action

Validate a Dependra landscape manifest, bundle it, authenticate, and sync it to Dependra —
posting the result back. **Applies only on a `release` or a push to the default branch**; every
other trigger (a feature-branch push, `workflow_dispatch`, or any pull request) is a **dry-run**
that previews the diff as a PR comment. Unreviewed content never writes prod.

> Your repo declares its architecture in `.dependra/manifest.yaml`; this Action keeps your Dependra
> landscape in lock-step with the code, on every merge and release.

## Usage

```yaml
permissions:
  id-token: write        # mint the OIDC token exchanged for a scoped Dependra key
  contents: read         # check out the manifest
  pull-requests: write   # post the dry-run diff comment on PRs

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dependra-io/upload-manifest@v1
        with:
          tenant-id: ${{ vars.DEPENDRA_TENANT_ID }}
```

> The Action lives at the **root** of this repository, so the reference is
> `dependra-io/upload-manifest@v1` — no path segment. See [Publishing](#publishing).

A ready-to-copy consumer workflow (with the PR → dry-run / release → apply trigger matrix) lives at
[`examples/dependra-sync.yml`](examples/dependra-sync.yml).

## Inputs

| Input          | Required | Default                    | Description |
|----------------|----------|----------------------------|-------------|
| `manifest`     | no       | `.dependra/manifest.yaml`  | Path to the root manifest YAML. |
| `dependra-url` | no       | `https://dependra.io`      | Base URL of the Dependra instance. Defaults to the hosted service; override only for self-hosted. |
| `tenant-id`    | **yes**  | —                          | Target tenant id (GUID). The exchange + ingest are tenant-addressed. |
| `mode`         | no       | *(auto)*                   | `dry-run` \| `apply`. Auto: apply **only** on `release` or a push to the default branch; every other trigger → dry-run. |
| `api-key`      | no       | —                          | Dependra API key (`dep_…`) with the `manifest-sync` scope. Used **instead of** OIDC. Masked in logs. |
| `audience`     | no       | `https://dependra.io`      | OIDC audience; must match Dependra's configured audience. |
| `fail-on`      | no       | `error`                    | Validation severity that fails the step (`error` or `warning`). |
| `github-token` | no       | `${{ github.token }}`      | Token for the PR comment; needs `pull-requests: write`. |
| `allow-pull-request-target` | no | `false`             | **Dangerous.** Opt-in to run the OIDC exchange under `pull_request_target` — see the warning below. Leave `false`. |

## Outputs

| Output          | Description |
|-----------------|-------------|
| `applied`       | `true` when the manifest was actually written (not a dry-run, not an idempotent replay). |
| `manifest-hash` | The manifest fingerprint Dependra used for the idempotency key. |
| `diff`          | The rendered import diff (markdown). |

## Authentication

Two mutually-exclusive paths:

1. **GitHub OIDC (recommended, keyless).** With `permissions: id-token: write`, the Action requests a
   GitHub OIDC JWT for `audience` and POSTs it to
   `POST {dependra-url}/api/{tenant-id}/integrations/github/token`. On success it receives a
   short-lived, `manifest-sync`-scoped Dependra key. A tenant owner must first whitelist the
   repository (`.../integrations/github/bindings`) or the exchange returns **403**.
2. **API key fallback.** Supply `api-key` (a `dep_…` key with the `manifest-sync` scope). The OIDC
   exchange is skipped.

In both cases the resulting credential is masked (`::add-mask::` with the **raw** secret bytes, so
the mask matches what's sent in the `Authorization` header) **before** it is ever used, and never
printed. The short-lived OIDC JWT itself is masked defensively too.

## Behaviour

- **Validate → annotate.** Every manifest issue becomes a GitHub `::error file=…,line=…::`
  annotation. The step fails if any issue meets `fail-on` (default: any error).
- **Bundle.** The validated manifest is packaged into the self-contained transport bundle
  (`{ manifest, docs, hashes }`) and transformed into the tenant-addressed ingest wire shape.
- **Sync.** POSTed to `POST {dependra-url}/api/{tenant-id}/integrations/manifest-sync?dryRun=true|false` (`true` = dry-run, `false` = apply).
  A run **applies** only on `release` or a push to the default branch; every other trigger is a
  dry-run. Idempotent per commit SHA — a retried run never double-applies.
- **Surface.** On `pull_request` the diff is upserted as a single PR comment; otherwise it goes to the
  job summary.

## Resilience

- Network calls have a **timeout** and a **bounded retry** (safe because ingest is idempotent per SHA).
- A Dependra **outage fails soft on `pull_request`** (posts "sync unavailable", neutral check) but
  **fails hard on `release`/push** — a broken mainline sync must be loud.
- A **manifest validation error always fails hard**, even on a pull request — a bad manifest is a
  code defect, not a transient condition.

## Fork PRs

A pull request **from a fork** gets **no OIDC token** (`id-token` can't be minted for an untrusted
fork) and a **read-only `GITHUB_TOKEN`**. When there's no `api-key` fallback either, the Action can't
authenticate, so:

- the check exits **neutral** (not a red X) with a "sync unavailable on fork PRs (no OIDC) — will
  apply on merge" notice;
- the PR comment upsert falls back to the **job summary** (the read-only token can't write comments);
- the manifest still **applies on merge** to the default branch, where OIDC is available.

Validation is unaffected — a malformed manifest still fails the check on a fork PR.

## `pull_request_target` — avoid

> **Warning:** Do **not** use this Action with the `pull_request_target` event, especially combined
> with checking out the PR head. `pull_request_target` runs in the trusted **base** context with full
> secrets and a **write** token against **untrusted PR-head code** — a classic credential-exfiltration
> vector. Use the `pull_request` event instead (it's dry-run and correctly unprivileged on forks).
>
> As a guard, the Action **refuses the OIDC token exchange under `pull_request_target`** and exits
> neutral unless you set `allow-pull-request-target: true`. Only opt in if you fully understand the
> exposure and never check out untrusted head code in the same job.

## Publishing

The Action lives at the **root** of this repository; reference it as
`dependra-io/upload-manifest@v1` — no path segment.

The Action imports a **committed, pre-built single-file CLI bundle** it ships with —
`vendor/manifest-cli.mjs` (an [esbuild](https://esbuild.github.io/) bundle of the `dependra` CLI, with
`manifest.schema.json` vendored beside it). It therefore **does not run `npm ci`/`npm run build` at
runtime** — it works on offline/locked-down runners (no npm-registry egress) with lower latency and a
smaller per-run supply-chain surface.

**Refreshing the bundle.** The CLI source lives in a separate repository; each CLI release builds the
bundle (`manifest-cli.mjs` + `manifest.schema.json`) and commits it here under `vendor/`. Keep the
vendored bundle in step with the published CLI version.

Tagging strategy: publish immutable **`v1.x.y`** release tags and a **moving `v1`** tag that
maintainers advance to each new `v1.x.y` (see [Versioning](#versioning)).

## Versioning

- Consume the **moving `v1` tag** (`@v1`) for automatic non-breaking updates.
- Immutable release tags **`v1.x.y`** are also published; pin to one (`@v1.2.3`) for byte-for-byte
  reproducibility.
- A breaking change ships as `v2` (and a new `v2.x.y` line); `v1` keeps receiving compatible fixes.

Maintainers move `v1` to each new `v1.x.y`:

```bash
git tag -fa v1 -m "v1 → v1.2.3" v1.2.3
git push origin v1 --force
```

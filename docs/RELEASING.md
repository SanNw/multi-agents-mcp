# npm release preparation

The manual `publish.yml` workflow is prepared but requires external operator configuration before it can publish. No npm publisher, GitHub environment, release tag, or registry setting is created by adding this file.

## One-time operator setup

1. Review the workflow and configure the GitHub environment named `npm` with required reviewer approval and deployment rules allowing only intended release tags. The YAML environment reference alone does not establish protection rules.
2. In the npm package settings, add a GitHub trusted publisher for owner `SanNw`, repository `multi-agents-mcp`, workflow filename `publish.yml`, and environment `npm`. Allow direct publishing for this relationship. Do not add an npm token as a repository secret.
3. Ensure the package repository URL matches that repository and restrict release-tag creation according to the repository's operator policy.

The [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) currently requires Node >=22.14.0 and npm >=11.5.1 on supported hosted runners. This workflow selects Node 24 and fails if its bundled npm is too old; it does not upgrade the package's runtime minimum. The configured caller filename, repository, and environment must match the OIDC claims exactly.

## Authorized release procedure

1. Review changes, update the version intentionally, and obtain successful existing CI for that exact commit. Complete the normal release authorization before creating the matching tag `v<version>`.
2. Dispatch **Publish npm** using that tag as its ref and its exact stable version as the input. This workflow accepts stable `major.minor.patch` versions only; prerelease policy is deferred.
3. Approve the protected `npm` environment deployment. The workflow checks version/tag/commit equality and a completed successful `ci.yml` run for the same SHA, installs dependencies, runs tests and release staging, and packs once.
4. The uploaded tarball is the same local tarball passed to `npm publish --provenance`; its SHA-512 integrity is checked against both the pack metadata and the published registry version. Inspect the artifact, workflow logs, npm provenance, and intended dist-tag before reporting a completed release.

There is no automatic publication on push or tag creation. Only the publish job receives `id-token: write`; the GitHub token is used solely to read CI run status. No long-lived npm credential is configured.

If publication times out or registry verification fails, inspect the exact version on npm before taking further action. Publication may have succeeded even when verification has not. Never retry a publish blindly; registry propagation can delay a read and version publication is irreversible.

## Manual recovery

The existing interactive release process remains available: use the reviewed tarball, authenticate through the operator's browser/Edge npm login and 2FA flow, publish that exact file, and verify registry integrity, version, dist-tag, and provenance when applicable. Do not persist session credentials in project files. Manual publication and configuring a trusted publisher both require explicit operator authorization; neither was performed during preparation.

## Local verification

`node --test scripts/publish-workflow.test.mjs` parses the YAML and checks triggers, permissions, existing pinned action identities, version/tag/SHA and CI gates, and the one-pack/exact-tarball/provenance/integrity path. It performs no network or publication. These fixture checks cannot prove that external npm trust, GitHub environment rules, or a real OIDC exchange are configured correctly.

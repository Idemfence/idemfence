# Contributing to idemfence

Thanks for your interest in idemfence. Please read the
[Code of Conduct](CODE_OF_CONDUCT.md) before taking part. To report a security
vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## How to contribute

All changes go through a pull request to `main`. Nobody pushes to `main` directly,
including the maintainer.

1. Fork the repository and create a branch from `main`.
2. Make your change and sign off every commit (see below).
3. Open a pull request against `main` and fill in the pull request template.

## Developer Certificate of Origin (DCO)

Every commit must be signed off to certify that you wrote it or otherwise have the
right to submit it under the project's license, as described by the
[Developer Certificate of Origin](https://developercertificate.org).

Sign off by committing with `-s`:

```sh
git commit -s -m "fix: describe the change"
```

This adds a trailer to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email in the trailer must match the commit's author. The `dco` check
fails the pull request if any commit is missing a matching sign-off. To fix the most
recent commit, run `git commit --amend -s --no-edit`. For earlier commits, run
`git rebase --signoff main`. Then force-push your branch.

Keep your branch current with `git rebase --signoff`, not GitHub's "Update branch"
button: the `dco` check also validates merge commits, and that button creates one
without a sign-off.

## Running the tests

The store tests run against a real PostgreSQL 18 and fail, rather than skip, when
`IDEMFENCE_TEST_DATABASE_URL` is unset. Start one with Docker and point the variable at it:

```sh
docker run --rm -d --name idemfence-postgres -e POSTGRES_PASSWORD=idemfence -p 5432:5432 postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636
export IDEMFENCE_TEST_DATABASE_URL=postgres://postgres:idemfence@localhost:5432/postgres
```

The tests create and drop their own schemas. Some run against the built package, so run
`pnpm build` before `pnpm test`.

## Releasing

Releases go through npm's staged publishing with trusted publishing (OIDC); no npm token
exists anywhere. The steps are:

1. **Version in a normal pull request.** Run `pnpm changeset version`, which consumes the
   pending changesets, bumps `packages/idemfence/package.json` and writes the version's
   section in `packages/idemfence/CHANGELOG.md`. Commit it signed off and open a pull request
   like any other change.
2. **Merge** the pull request once it is green and reviewed.
3. **`release.yml` runs on the push to `main`.** It publishes only when the package version is
   not on npm yet and has a matching `CHANGELOG.md` heading, that is, it was produced by
   `changeset version`. Its read-only `build` job runs the artifact tests and uploads the
   packed tarball; the `publish` job (OIDC token only, GitHub environment `npm-release`,
   restricted to `main`) verifies that tarball's sha256 and stages it with
   `npm stage publish`; the `draft-release` job creates a *draft* GitHub release named
   `idemfence@<version>` whose body is that CHANGELOG section. No tag is created yet.
   The trusted publisher on npmjs.com must be configured with workflow `release.yml` and
   environment `npm-release`.

   A version that is staged but not yet approved still reads as "not on npm" (404), so a
   rerun of the workflow for the same version fails at `npm stage publish`; that is expected.
   Approve or reject the pending stage first.

   On pull requests, CI's `release-dry-run-*` jobs mirror these three jobs. The
   `npm stage publish --dry-run` of the real tarball runs on the version pull request (where
   `release.yml` would publish); on every other pull request it is skipped by design, because a
   version that already exists on npm cannot be dry-run staged, while the tarball is still
   packed, uploaded and verified by sha256.
4. **The maintainer verifies and approves the staged package on npm.** Before approving:
   run `npm stage download <stage-id>` and compute the tarball's sha256; pack the same commit
   locally from a fresh clone (`pnpm install --frozen-lockfile && pnpm build`, then `pnpm pack`
   in `packages/idemfence`) and compute that sha256; approve (`npm stage approve <stage-id>`
   or the Staged Packages tab on npmjs.com, with 2FA) only if both equal the sha256 logged by
   `release.yml`'s `build` job; otherwise `npm stage reject` it. `pnpm pack` is reproducible:
   for 0.0.0 the registry tarball, the CI build and an independent local build on another
   machine and Node version all had the same sha256. Only after approval is the version
   publicly installable.
5. **The maintainer publishes the draft release**, which creates the immutable tag
   `idemfence@<version>` (a tag ruleset blocks updating or deleting these tags).

History: version 0.0.0 was published manually by the maintainer to create the package on npm,
which trusted publishing requires. It has no CHANGELOG entry, so `release.yml` never
publishes it. This is not part of the procedure above.

## Definition of done

A pull request is ready to merge only when all of the following hold:

1. **CI is green.** Every required check passes.
2. **Tests run against real servers and backends.** No mocked store, framework or clock.
3. **No placeholders in library code.** No stubs, TODO implementations or
   not-implemented paths.
4. **Docs and a changeset for user-visible changes.** Update the documentation and add
   a changeset describing the change.
5. **Independent review for material changes.** Someone other than the author reviews
   any change to behavior, public API, storage format or security properties.

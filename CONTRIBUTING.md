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

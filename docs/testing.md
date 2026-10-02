# Testing

## Required local checks

```sh
npm ci
npm run check
npm run build
npm run test:integration
```

`check` runs lint, TypeScript and unit tests. Integration tests launch an isolated production server on port 3411 and an AI fixture on port 3412. They use temporary storage and leave the normal workspace untouched. Keep those ports free.

The fixture verifies streaming completion, aborted requests, persistence, optimistic conflicts, atomic ADR decisions, imports / exports, origin checks and history. It is not proof of real model quality.

## Static Pages

```sh
CI_PAGES_URL=https://pages.example.test/team/project \
CI_SERVER_URL=https://gitlab.example.test \
CI_PROJECT_PATH=team/project \
HOOSPEC_PAGES_PATH=hoospec npm run build:pages

CI_PAGES_URL=https://pages.example.test/team/project \
HOOSPEC_PAGES_PATH=hoospec npm run test:pages
```

The smoke check verifies that all referenced static assets exist at the computed base path and no API handlers, workspace files or server entrypoint appear in the export. It does not replace a real OAuth / Pages access-control test.

## Container

```sh
docker build -t hoospec:test .
npm run test:container -- hoospec:test
```

The test uses a unique container, loopback port and named volume. It verifies the non-root user, HTML / static assets, a real JSON save, foreign-origin rejection and persistence after restart. Its temporary container and volume are removed afterward.

## Optional disposable GitLab test

Start a local disposable GitLab instance with a usable API token. Supply the token using a protected file; never pass it in a CLI argument or commit it.

```sh
HOOSPEC_TEST_GITLAB_URL=http://127.0.0.1:8929 \
HOOSPEC_TEST_GITLAB_TOKEN_FILE=/path/to/protected/test-token \
npm run test:gitlab
```

The fixture refuses remote hosts, creates a private test project and verifies discovery, deferred atomic draft-MR commits, shared-session joining, local undo/redo, ADR decisions, conflicting drafts, externally changed generated files and an explicit GitLab merge. The project is intentionally left for inspection. Metadata is written without credentials to an exclusively created file inside a private, unpredictable temporary directory. The fixture prints its metadata path for inspection. The token is for fixture setup, not the application's OAuth login.

For release testing, also exercise Pages access control with an anonymous visitor, a nonmember, a reporter and a Developer submitting against a protected target branch. Verify OAuth using a public application with the exact deployed callback URL, and inspect the MR source / JSON commit in GitLab. Reload before synchronizing and verify the local draft is automatically restored after OAuth; verify credentials are absent from the draft store.

## Release checks

- Run the GitHub workflow locally equivalent commands and review their results.
- Run `actionlint .github/workflows/ci.yml` if actionlint is available.
- Scan the files intended for publication with Gitleaks using `--redact`.
- Review the ignore files, dependency audit, license and documentation.
- Use isolated test content for desktop / mobile screenshots and verify keyboard behavior in a browser.

## Copilot login through a real GitLab runner

```sh
HOOSPEC_TEST_GITLAB_TOKEN_FILE=/protected/local-gitlab-token npm run test:copilot:gitlab
```

This fixture is restricted to a disposable local GitLab instance (`HOOSPEC_TEST_GITLAB_URL`, default `http://127.0.0.1:8929`). It requires the local isolated project runner named `Hoospec isolated test runner` and a fixture token that can create projects and attach that runner. The token is read from a protected file and never printed.

The test creates a private project, commits the actual login helper and CI template, starts a real API pipeline, reads its challenge from the running job trace, downloads and decrypts its encrypted artifact, and exercises the browser adapter's model list and streamed edit. The fixture project is deleted afterward. GitHub OAuth and Copilot responses are synthetic; this proves the GitLab runner transport and encryption, not real subscription entitlement or inference. Production verification needs an independently registered OAuth App with Device Flow and a consenting Copilot account.

Unit tests additionally verify wrong-tab and wrong-pipeline decryption failures, expiry, tampering, pending/slow-down responses, debug-trace rejection, endpoint restrictions and incomplete generation rejection.

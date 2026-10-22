# Manual release process

Releases are published by the `publish.yml` GitHub Actions workflow (`.github/workflows/publish.yml`).

## Prerequisites

- Write access to the repository (to run the workflow on `main`).
- A repository secret named `RELEASE_PAT` (a personal access token with repo push rights). The workflow uses it to push the version commit and tag back to `main`.
- npm publish credentials for the `@mortz.dev` scope: either npm Trusted Publishing (OIDC, recommended) or an `NODE_AUTH_TOKEN` secret.

## Steps

1. Go to **Actions → Release npm package → Run workflow**.
2. Choose the version bump (`patch`, `minor`, or `major`) and run it on `main`.
3. The workflow:
   - installs dependencies and runs tests, lint, and typecheck;
   - bumps `package.json`/`package-lock.json`, commits, and pushes the `vX.Y.Z` tag;
   - builds `dist/` and publishes to npm;
   - creates a GitHub Release with auto-generated notes.

You can also dispatch it from the CLI:

```bash
gh workflow run publish.yml -f bump=patch
```

The workflow requires `main` and refuses to run on any other ref.

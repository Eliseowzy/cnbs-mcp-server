# GitHub Actions

`ci.yml` runs lint, build, and tests on Node.js 22 and 24 for pushes and pull requests.

`docker.yml` builds the Docker image for pull requests, and publishes it to GitHub Container Registry for pushes to `main`/`master`, semantic-version tags, and prerelease tags. The image name is `ghcr.io/<owner>/<repo>`, for example `ghcr.io/eliseowzy/cnbs-mcp-server`.

`release.yml` creates a GitHub Release with generated release notes when a semantic-version tag such as `1.2.0` or prerelease tag such as `1.2.0-beta.1` is pushed.

Before publishing a release tag locally, run:

```bash
npm ci
npm run lint
npm run build
npm test -- --runInBand
```

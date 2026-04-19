# Releasing

1. Update `CHANGELOG.md` — replace `[Unreleased]` with `[X.Y.Z] - YYYY-MM-DD`
2. Commit: `git commit -m "Update changelog for X.Y.Z"`
3. Bump version: `npm version <patch|minor|major>`
   - This bumps `package.json`, commits, and tags automatically
4. Push: `git push && git push --tags`
5. GitHub Actions publishes to npm on the tag
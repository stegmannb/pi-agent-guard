# Releasing

1. Update `CHANGELOG.md` — replace `[Unreleased]` with `[X.Y.Z] - YYYY-MM-DD`
2. Commit: `git commit -m "Update changelog for X.Y.Z"`
3. Bump version: `npm version <patch|minor|major>`
   - This bumps `package.json`, commits, and tags automatically
4. Push: `git push && git push --tags`
5. GitHub Actions publishes to npm on the tag
6. Test the published package:
   - Remove local path from `~/.pi/agent/settings.json` `packages` array
   - Install: `npm_config_userconfig=/dev/null pi install npm:pi-guard`
   - Verify with `/guard list` in pi

   The `npm_config_userconfig=/dev/null` bypasses `~/.npmrc` to avoid conflicts
   between `min-release-age` and npm's `--before` flag during git dep preparation.
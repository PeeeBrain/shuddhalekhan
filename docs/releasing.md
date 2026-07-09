# Releasing Shuddhalekhan

Releases are explicit, human-approved actions. A version tag is the release
trigger: pushing `vX.Y.Z` starts the GitHub Actions workflow that validates,
packages, and publishes the Windows app to GitHub Releases.

Do not create, move, delete, or push a release tag unless a human explicitly
approves the release.

## Prepare the release

1. Create a release PR that updates the version in `package.json` and adds the
   final user-visible changes to `CHANGELOG.md` under `## vX.Y.Z`. Remove those
   entries from `## Unreleased` (leave `No unreleased changes.` when empty).
2. Run the release checks:

   ```powershell
   bun run lint
   bun run typecheck
   bun test
   ```

3. Merge the release PR into `main` and confirm the `CI` workflow passed.

## Create the release

From the merged `main` commit, after explicit approval:

```powershell
git checkout main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag must exactly match `package.json`'s version. The release workflow also
requires a matching `## vX.Y.Z` section in `CHANGELOG.md`; it fails before
packaging when either check does not pass.

The workflow reruns typecheck, lint, and tests, builds the app, uploads the
Electron Builder artifacts, and sets the GitHub Release body to that version's
changelog section. Monitor the workflow and verify the published release and
Windows installer before announcing it.

## Correcting a release

Do not retag a published release. Create a new patch release (for example,
`vX.Y.(Z+1)`) with a changelog entry that explains the correction.

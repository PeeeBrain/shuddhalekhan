# Releasing Shuddhalekhan

This document is the release runbook for Shuddhalekhan. Releases are built from
Git tags by GitHub Actions and Electron Builder. The tag is the only authority
for the release version; the committed `package.json` deliberately carries a
neutral development version.

## Human approval requirement

Creating a release is a human-in-the-loop process. Do not create, move, delete,
or push a version tag unless the user explicitly requests a release or approves
a specific recommended release version.

Feature work, documentation work, CI work, or a version-looking changelog entry
does not imply permission to create a release. Stop before tag creation and ask
for approval.

## Release model

```text
git tag v4.5.2
git push origin v4.5.2
        |
        v
GitHub Actions validates the semantic version tag
        |
        v
The runner injects 4.5.2 into package.json
        |
        v
Electron Builder packages the Windows app into a draft release
        |
        v
Metadata is finalized and the GitHub Release is published
```

`package.json` is changed only on the disposable Actions runner. Release
version bumps are never committed to the repository.

## Before tagging

1. Confirm the user explicitly requested the release or approved the exact
   semantic version.
2. Confirm the intended release commit is on `main` and the working tree only
   contains intended changes:

   ```powershell
   git checkout main
   git pull --ff-only
   git status --short
   ```

3. Run the release checks:

   ```powershell
   bun run lint
   bun run typecheck
   bun test
   ```

4. Review `CHANGELOG.md` for useful human-facing project history. Changelog
   organization is not a release gate, and GitHub release notes do not come
   from this file.

## Create the release

Only after explicit approval, choose the semantic version and push its tag:

```powershell
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag triggers `.github/workflows/release.yml`. The workflow derives
`X.Y.Z` from the tag, injects it into the application metadata, reruns all
checks, builds the app, generates the GitHub Release body from the explicitly
selected previous reachable release tag, and uploads Electron Builder artifacts
and auto-update metadata to a draft. The release becomes public only after its
title and notes are finalized.

## Verify the release

After the workflow completes:

1. Confirm the `Release Windows App` workflow succeeded for the tag.
2. Confirm the GitHub Release is published under the same tag.
3. Confirm the Windows installer and `latest.yml` are attached.
4. Install or update the app and confirm its displayed version matches the tag.

## If a release fails

Do not delete or move a pushed tag without explicit human approval. Report the
tag, failed workflow run, failed step, and proposed correction. Ask whether to
move the existing tag or create a new patch release before changing release
state.

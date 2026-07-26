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

4. Review the `Unreleased` section in `CHANGELOG.md`. It must be non-empty and
   contain only the user-facing changes intended for this release. The release
   workflow uses that structurally bounded section as the single source for the
   GitHub Release body and the release-notes payload bundled with the app.

## Create the release

Only after explicit approval, choose the semantic version and push its tag:

```powershell
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag triggers `.github/workflows/release.yml`. The workflow derives
`X.Y.Z` from the tag, injects it into the application metadata, reruns all
checks, extracts the `Unreleased` changelog section, stamps it with the tag
version, and bundles it into the application. The same content becomes the
GitHub Release body, so update prompts and the installed app present exactly the
notes reviewed before tagging. Electron Builder artifacts and auto-update
metadata are uploaded to a draft. The release becomes public only after its
title and notes are finalized.

After the release is published, move the released entries from `Unreleased`
under a new `## vX.Y.Z` heading and restore an empty `Unreleased` section in a
follow-up commit. Do not move entries before tagging because the tagged commit
is the immutable source used by the release workflow.

## Verify the release

After the workflow completes:

1. Confirm the `Release Windows App` workflow succeeded for the tag.
2. Confirm the GitHub Release is published under the same tag.
3. Confirm the Windows installer and `latest.yml` are attached.
4. Install or update the app and confirm its displayed version matches the tag.
5. Confirm the update prompt or Settings → About shows the same notes as the
   GitHub Release. On the first release containing this feature, verify the
   post-install “What’s New” prompt instead of the pre-update prompt.

## If a release fails

Do not delete or move a pushed tag without explicit human approval. Report the
tag, failed workflow run, failed step, and proposed correction. Ask whether to
move the existing tag or create a new patch release before changing release
state.

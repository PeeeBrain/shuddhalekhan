# Shuddhalekhan 4.0.1

This hotfix resolves a packaged Agent Mode startup regression introduced in 4.0.0.

## What's Changed

- Fixed packaged Agent Mode sidecar launch so it runs under Electron's Node mode instead of recursively launching full Shuddhalekhan app instances.
- Added a single-instance startup guard so duplicate full app launches exit immediately.

## Update Note

Users on 4.0.0 should update immediately, especially if Agent Mode was enabled before restarting the app.

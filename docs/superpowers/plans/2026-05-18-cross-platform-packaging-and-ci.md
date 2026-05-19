# Cross-Platform Packaging And CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add platform-scoped CI and release packaging for Windows, Linux `.deb`, and unsigned macOS experimental artifacts.

**Architecture:** Split CI into separate platform workflows so each release workflow can depend on its matching platform only. Keep one GitHub Release per semantic version and allow platform assets to backfill the same release as they become available.

**Tech Stack:** GitHub Actions, Blacksmith runners via repository variables, Bun, Electron Builder, GitHub CLI.

**Scope Guard:** This plan does not implement shortcut providers or permissions. Normalizing Windows away from `koffi` is a future refactor after Electron APIs prove they can preserve Windows behavior.

---

### Task 1: Electron Builder Platform Targets

**Files:**
- Modify: `D:\git_repos\speech-2-text\package.json`
- Modify: `D:\git_repos\speech-2-text\release-notes.md`

- [ ] **Step 1: Update Electron Builder config**

In `package.json`, extend the existing `"build"` object with Linux and macOS targets:

```json
"mac": {
  "target": ["dmg", "zip"],
  "category": "public.app-category.productivity"
},
"linux": {
  "target": ["deb"],
  "category": "Utility",
  "maintainer": "parthashirolkar"
}
```

Keep the existing Windows block unchanged:

```json
"win": {
  "target": "nsis",
  "icon": "icons/tray-icon.ico"
}
```

- [ ] **Step 2: Add platform availability section to release notes**

In `release-notes.md`, add this section near the top of the current release notes:

```markdown
## Platform Artifacts

| Platform | Status | Artifact |
| --- | --- | --- |
| Windows | Stable | NSIS installer |
| Linux | Experimental | Debian/Ubuntu `.deb` |
| macOS | Developer Preview | Unsigned `.dmg` / `.zip` |
```

- [ ] **Step 3: Run config checks**

Run:

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add package.json release-notes.md
git commit -m "chore: declare cross-platform package targets"
```

### Task 2: Split CI By Platform

**Files:**
- Modify: `D:\git_repos\speech-2-text\.github\workflows\ci.yml`
- Create: `D:\git_repos\speech-2-text\.github\workflows\ci-linux.yml`
- Create: `D:\git_repos\speech-2-text\.github\workflows\ci-macos.yml`

- [ ] **Step 1: Keep Windows CI as its own workflow**

Replace the `name` in `.github/workflows/ci.yml`:

```yaml
name: CI Windows
```

Keep the Windows job shape, but change `runs-on` to a repository variable:

```yaml
runs-on: ${{ vars.BLACKSMITH_WINDOWS_RUNNER }}
```

Keep this Windows-only native dependency step:

```yaml
- name: Verify Electron native dependencies
  run: bun x electron-builder install-app-deps
```

The complete Windows workflow should still run on pull requests, pushes to main, and manual dispatch.

- [ ] **Step 2: Create Linux CI workflow**

Create `.github/workflows/ci-linux.yml`:

```yaml
name: CI Linux

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-linux-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  checks:
    name: Linux typecheck, lint, and test
    runs-on: ${{ vars.BLACKSMITH_LINUX_RUNNER }}
    timeout-minutes: 20

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Lint
        run: bun run lint

      - name: Test
        run: bun test
```

- [ ] **Step 3: Create macOS CI workflow**

Create `.github/workflows/ci-macos.yml`:

```yaml
name: CI macOS

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-macos-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  checks:
    name: macOS typecheck, lint, and test
    runs-on: ${{ vars.BLACKSMITH_MACOS_RUNNER }}
    timeout-minutes: 20

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Lint
        run: bun run lint

      - name: Test
        run: bun test
```

- [ ] **Step 4: Document required Actions variables in the workflow comments**

Add this comment near the top of each CI workflow:

```yaml
# Required repository variables:
# - BLACKSMITH_WINDOWS_RUNNER for CI Windows
# - BLACKSMITH_LINUX_RUNNER for CI Linux
# - BLACKSMITH_MACOS_RUNNER for CI macOS
```

Do not hardcode Linux or macOS runner labels. The repository owner manages exact Blacksmith labels.

- [ ] **Step 5: Validate workflow files visually**

Run:

```powershell
Get-Content .github\workflows\ci.yml
Get-Content .github\workflows\ci-linux.yml
Get-Content .github\workflows\ci-macos.yml
```

Expected: three workflows, each with one `jobs.checks` job and no duplicated top-level keys.

- [ ] **Step 6: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/ci-linux.yml .github/workflows/ci-macos.yml
git commit -m "ci: split checks by platform"
```

### Task 3: Split Release Workflows By Platform

**Files:**
- Modify: `D:\git_repos\speech-2-text\.github\workflows\release.yml`
- Create: `D:\git_repos\speech-2-text\.github\workflows\release-linux.yml`
- Create: `D:\git_repos\speech-2-text\.github\workflows\release-macos.yml`

- [ ] **Step 1: Rename Windows release workflow and bind it to Windows CI**

Update `.github/workflows/release.yml`:

```yaml
name: Release Windows App

on:
  workflow_run:
    workflows: [CI Windows]
    types: [completed]
    branches: [main]
  workflow_dispatch:
```

Change `runs-on` to:

```yaml
runs-on: ${{ vars.BLACKSMITH_WINDOWS_RUNNER }}
```

Keep Windows as the only automatically published stable platform.

- [ ] **Step 2: Create Linux release workflow**

Create `.github/workflows/release-linux.yml`:

```yaml
name: Release Linux App

on:
  workflow_run:
    workflows: [CI Linux]
    types: [completed]
    branches: [main]
  workflow_dispatch:

jobs:
  release-linux:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ${{ vars.BLACKSMITH_LINUX_RUNNER }}
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build
        run: bun run build

      - name: Package Linux deb
        run: bun x electron-builder --linux deb --publish never

      - name: Publish Linux assets
        shell: pwsh
        run: .github/scripts/publish-platform-release.ps1 -Platform linux
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Create macOS release workflow**

Create `.github/workflows/release-macos.yml`:

```yaml
name: Release macOS App

on:
  workflow_run:
    workflows: [CI macOS]
    types: [completed]
    branches: [main]
  workflow_dispatch:

jobs:
  release-macos:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ${{ vars.BLACKSMITH_MACOS_RUNNER }}
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build
        run: bun run build

      - name: Package macOS unsigned artifacts
        run: bun x electron-builder --mac --publish never

      - name: Publish macOS assets
        shell: pwsh
        run: .github/scripts/publish-platform-release.ps1 -Platform macos
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Commit release workflows**

```powershell
git add .github/workflows/release.yml .github/workflows/release-linux.yml .github/workflows/release-macos.yml
git commit -m "ci: split release workflows by platform"
```

### Task 4: Shared Release Publisher Script

**Files:**
- Create: `D:\git_repos\speech-2-text\.github\scripts\publish-platform-release.ps1`
- Modify: `D:\git_repos\speech-2-text\.github\workflows\release.yml`

- [ ] **Step 1: Create publisher script**

Create `.github/scripts/publish-platform-release.ps1`:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("windows", "linux", "macos")]
  [string] $Platform
)

$ErrorActionPreference = "Stop"

$version = (Get-Content package.json | ConvertFrom-Json).version
$tag = "v$version"

$release = gh release view $tag --json isDraft 2>$null
if ($LASTEXITCODE -ne 0) {
  gh release create $tag --draft --title "Shuddhalekhan $version" --notes-file release-notes.md
}

$patterns = switch ($Platform) {
  "windows" { @("release/*.exe", "release/*.blockmap", "release/latest.yml") }
  "linux" { @("release/*.deb", "release/latest-linux.yml") }
  "macos" { @("release/*.dmg", "release/*.zip", "release/latest-mac.yml") }
}

$assets = @()
foreach ($pattern in $patterns) {
  $assets += Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue
}

if ($assets.Count -eq 0) {
  throw "No release assets found for platform '$Platform'."
}

foreach ($asset in $assets) {
  gh release upload $tag $asset.FullName --clobber
}

if ($Platform -eq "windows") {
  gh release edit $tag --notes-file release-notes.md --draft=false
} else {
  gh release edit $tag --notes-file release-notes.md
}
```

- [ ] **Step 2: Change Windows release workflow to use publisher script**

In `.github/workflows/release.yml`, replace the existing release-state, publish, and notes-edit steps with:

```yaml
- name: Package Windows
  run: bun x electron-builder --win --publish never

- name: Publish Windows assets
  shell: pwsh
  run: .github/scripts/publish-platform-release.ps1 -Platform windows
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Keep the existing `Build` step before packaging.

- [ ] **Step 3: Run static script check**

Run:

```powershell
powershell -NoProfile -Command "$null = [scriptblock]::Create((Get-Content .github/scripts/publish-platform-release.ps1 -Raw)); 'ok'"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```powershell
git add .github/scripts/publish-platform-release.ps1 .github/workflows/release.yml
git commit -m "ci: publish platform assets to one release"
```

### Task 5: Workflow Documentation

**Files:**
- Modify: `D:\git_repos\speech-2-text\README.md`
- Modify: `D:\git_repos\speech-2-text\CONTRIBUTING.md`

- [ ] **Step 1: Update README release section**

Add:

```markdown
### Platform Release Status

Shuddhalekhan uses one GitHub Release per app version. Platform artifacts are uploaded to that release as their platform jobs pass.

| Platform | Initial Status | Artifact |
| --- | --- | --- |
| Windows | Stable | NSIS installer |
| Linux | Experimental | Debian/Ubuntu `.deb` |
| macOS | Developer Preview | Unsigned `.dmg` / `.zip` |

Windows remains the stable release gate. Linux and macOS artifacts can be backfilled into the same release after platform-specific packaging succeeds.
```

- [ ] **Step 2: Update CONTRIBUTING CI section**

Add:

```markdown
CI is platform-scoped. `CI Windows` gates Windows release artifacts, `CI Linux` gates Linux artifacts, and `CI macOS` gates macOS artifacts. A failure on an experimental platform must not block publication of a stable Windows release.

Blacksmith runner labels are configured through repository variables:

- `BLACKSMITH_WINDOWS_RUNNER`
- `BLACKSMITH_LINUX_RUNNER`
- `BLACKSMITH_MACOS_RUNNER`
```

- [ ] **Step 3: Commit**

```powershell
git add README.md CONTRIBUTING.md
git commit -m "docs: describe platform release gates"
```

### Task 6: Verification

**Files:**
- All files touched in this plan.

- [ ] **Step 1: Run non-build verification**

Run:

```powershell
bun run lint
bun run typecheck
bun test
```

Expected: all pass.

- [ ] **Step 2: Do not run packaging builds unless explicitly asked**

Do not run:

```powershell
bun run build
bun run dist
```

These create build outputs and are forbidden by `AGENTS.md` unless explicitly requested.

- [ ] **Step 3: Commit verification fixes if needed**

If verification requires source fixes, stage only the exact files changed by those fixes:

```powershell
git status --short
git add path/to/file1 path/to/file2
git commit -m "ci: verify platform release workflow"
```

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

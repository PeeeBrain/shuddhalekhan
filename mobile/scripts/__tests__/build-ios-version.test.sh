#!/usr/bin/env bash
set -euo pipefail

# The version probe must drain xcodebuild stdout under pipefail, even with verbose output.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT
cat > "$fixture_dir/uname" <<'MOCK'
#!/usr/bin/env bash
echo Darwin
MOCK
cat > "$fixture_dir/xcodebuild" <<'MOCK'
#!/usr/bin/env python3
import sys
sys.stdout.write("Xcode 25.0\n" + "Build version fixture\n" * 100000)
MOCK
# The version guard must reject this unsupported Xcode before invoking any build tools.
for tool in bun pod swiftc node zip openssl; do
  ln -s uname "$fixture_dir/$tool"
done
chmod +x "$fixture_dir/uname" "$fixture_dir/xcodebuild"
status=0
PATH="$fixture_dir:$PATH" bash "$script_dir/build-ios.sh" > "$fixture_dir/output" 2>&1 || status=$?
if [[ "$status" != 1 ]] || ! grep -q 'Expo SDK 58 requires Xcode 26.4 or newer; found 25.0.' "$fixture_dir/output"; then
  cat "$fixture_dir/output" >&2
  echo "Expected the Xcode version guard to reject 25.0 cleanly; got exit $status." >&2
  exit 1
fi
echo 'iOS version probe regression passed.'

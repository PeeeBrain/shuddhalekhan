#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build the iOS IPA on macOS with Xcode." >&2
  exit 1
fi

for tool in bun pod xcodebuild swiftc node zip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required build tool not found: $tool" >&2
    exit 1
  fi
done

xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2; exit }')"
if [[ ! "$xcode_version" =~ ^([0-9]+)\.([0-9]+) ]]; then
  echo "Could not read the Xcode version: $xcode_version" >&2
  exit 1
fi
xcode_major="${BASH_REMATCH[1]}"
xcode_minor="${BASH_REMATCH[2]}"
if (( xcode_major < 26 || (xcode_major == 26 && xcode_minor < 4) )); then
  echo "Expo SDK 58 requires Xcode 26.4 or newer; found $xcode_version." >&2
  exit 1
fi

mobile_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ios_dir="$mobile_dir/ios"
artifact_dir="$mobile_dir/build/ipa"
ipa_path="$artifact_dir/Shuddhalekhan-unsigned.ipa"
expected_bundle_id="com.shuddhalekhan.mobile"

cd "$mobile_dir"
bunx expo prebuild --platform ios --no-install
cd "$ios_dir"
pod install

workspace="$(find "$ios_dir" -maxdepth 1 -type d -name '*.xcworkspace' -print -quit)"
if [[ -z "$workspace" ]]; then
  echo "Expo prebuild did not create an Xcode workspace." >&2
  exit 1
fi

scheme="$(xcodebuild -list -json -workspace "$workspace" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const details = JSON.parse(input);
    const schemes = details.workspace?.schemes ?? details.project?.schemes ?? [];
    const appScheme = "Shuddhalekhan";
    if (!schemes.includes(appScheme)) {
      throw new Error(`Expected app scheme ${appScheme}; found: ${schemes.join(", ")}`);
    }
    process.stdout.write(appScheme);
  });
')"

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/shuddhalekhan-ios.XXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT
archive_path="$build_dir/Shuddhalekhan.xcarchive"

# Both targets must compile the same wire format and TCP framing.
for shared in KeyboardSessionProtocol.swift KeyboardSessionChannel.swift; do
  cmp "$mobile_dir/targets/transcript-keyboard/$shared" \
    "$mobile_dir/modules/shuddhalekhan-speech/ios/$shared"
done
swiftc \
  "$mobile_dir/targets/transcript-keyboard/KeyboardSessionProtocol.swift" \
  "$mobile_dir/native-checks/KeyboardSessionCheck.swift" \
  -o "$build_dir/check-keyboard-session"
"$build_dir/check-keyboard-session"
swiftc -swift-version 6 \
  "$mobile_dir/targets/transcript-keyboard/KeyboardSessionProtocol.swift" \
  "$mobile_dir/targets/transcript-keyboard/KeyboardSessionChannel.swift" \
  "$mobile_dir/modules/shuddhalekhan-speech/ios/KeyboardSessionServer.swift" \
  "$mobile_dir/native-checks/KeyboardBridgeCheck.swift" \
  -o "$build_dir/check-keyboard-bridge"
"$build_dir/check-keyboard-bridge"

xcodebuild \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -derivedDataPath "$build_dir/DerivedData" \
  archive \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=""

shopt -s nullglob
app_bundles=("$archive_path"/Products/Applications/*.app)
if [[ ${#app_bundles[@]} -ne 1 ]]; then
  echo "Expected one app bundle in the Xcode archive; found ${#app_bundles[@]}." >&2
  exit 1
fi
app_bundle="${app_bundles[0]}"
info_plist="$app_bundle/Info.plist"

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")"
if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  echo "Unexpected app bundle identifier: $bundle_id" >&2
  exit 1
fi

executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist")"
if [[ ! -x "$app_bundle/$executable_name" ]]; then
  echo "Release app bundle is missing its executable: $executable_name" >&2
  exit 1
fi

if [[ ! -s "$app_bundle/main.jsbundle" ]]; then
  echo "Release app bundle is missing the embedded main.jsbundle." >&2
  exit 1
fi

/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$info_plist" >/dev/null
/usr/libexec/PlistBuddy -c 'Print :NSLocalNetworkUsageDescription' "$info_plist" >/dev/null
# Keyboard sessions keep recording while another app is in front.
if ! /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$info_plist" | grep -qx '[[:space:]]*audio'; then
  echo "The app is missing the audio background mode that keyboard sessions need." >&2
  exit 1
fi

keyboard_bundles=("$app_bundle"/PlugIns/*.appex)
if [[ ${#keyboard_bundles[@]} -ne 1 ]]; then
  echo "Expected one embedded dictation keyboard; found ${#keyboard_bundles[@]}." >&2
  exit 1
fi
keyboard_plist="${keyboard_bundles[0]}/Info.plist"
keyboard_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$keyboard_plist")"
extension_type="$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$keyboard_plist")"
if [[ "$keyboard_id" != "$expected_bundle_id.transcript-keyboard" || "$extension_type" != "com.apple.keyboard-service" ]]; then
  echo "The embedded extension is not the expected Shuddhalekhan keyboard." >&2
  exit 1
fi

package_dir="$build_dir/package"
mkdir -p "$package_dir/Payload" "$artifact_dir"
ditto "$app_bundle" "$package_dir/Payload/$(basename "$app_bundle")"
(
  cd "$package_dir"
  zip -0 -X -y -r "$build_dir/Shuddhalekhan-unsigned.ipa" Payload
)
mv "$build_dir/Shuddhalekhan-unsigned.ipa" "$ipa_path"

if [[ ! -s "$ipa_path" ]]; then
  echo "IPA packaging failed." >&2
  exit 1
fi

echo "Created unsigned IPA at $ipa_path. Sideloadly must sign it before installation."

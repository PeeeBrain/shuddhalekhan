#!/usr/bin/env python3
"""Read the resolved Expo update runtime from an unsigned IPA."""
from pathlib import PurePosixPath
import plistlib
import re
import sys
import zipfile


def read_runtime(ipa):
    plists = [name for name in ipa.namelist() if name.startswith("Payload/")
              and name.endswith(".app/Expo.plist") and name.count("/") == 2]
    if len(plists) != 1:
        raise ValueError("Expected one app Expo.plist in the IPA")
    runtime = plistlib.loads(ipa.read(plists[0]))["EXUpdatesRuntimeVersion"]
    if runtime == "file:fingerprint":
        resource = PurePosixPath(plists[0]).parent / "EXUpdates.bundle/fingerprint"
        runtime = ipa.read(str(resource)).decode("utf-8").strip()
    if not isinstance(runtime, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_+.()-]*", runtime):
        raise ValueError("Missing or invalid IPA runtime version")
    return runtime


if __name__ == "__main__":
    with zipfile.ZipFile(sys.argv[1]) as ipa:
        print(f"version={read_runtime(ipa)}")

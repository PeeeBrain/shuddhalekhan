#!/usr/bin/env python3
"""Verify that a publication retry reuses one run's unchanged source and assets."""
from datetime import datetime
import json
import os
import re
import subprocess
import sys


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def verify_retry(run, jobs, logs, release, commit, tag):
    if run["path"] != ".github/workflows/release.yml" or not release["draft"]:
        raise ValueError("Expected a Release App run and a draft release")
    jobs = {job["name"]: job for job in jobs}
    version = tag.removeprefix("v")
    expected = {
        "release-windows": [f"Shuddhalekhan-Setup-{version}.exe", f"Shuddhalekhan-Setup-{version}.exe.blockmap", "latest.yml"],
        "release-linux": [f"shuddhalekhan-{version}-amd64.deb", f"shuddhalekhan-{version}-x86_64.rpm", "latest-linux.yml"],
        "release-ios": ["Shuddhalekhan-unsigned.ipa"],
    }
    assets = {asset["name"]: asset for asset in release["assets"]}
    for platform, names in expected.items():
        job = jobs.get(platform)
        if not job or job["conclusion"] != "success":
            raise ValueError(f"{platform} did not succeed")
        checkout = re.search(r"\[command\][^\r\n]+ log -1 --format=%H\r?\n\S+ ([0-9a-f]{40})(?:\r?\n|$)", logs[platform])
        if not checkout or checkout[1] != commit:
            raise ValueError(f"{platform} built a different commit or its checkout log is missing")
        for name in names:
            asset = assets.get(name)
            if (not asset or asset["size"] <= 0
                    or not datetime.fromisoformat(job["started_at"]) <= datetime.fromisoformat(asset["updated_at"]) <= datetime.fromisoformat(job["completed_at"])):
                raise ValueError(f"{name} is missing or was replaced outside the selected build")
    if set(assets) != {name for names in expected.values() for name in names}:
        raise ValueError("Draft contains assets outside the selected platform builds")
    return any(step["name"] == "Publish OTA update" and step["conclusion"] == "success"
               for step in jobs.get("finalize", {}).get("steps", []))


if __name__ == "__main__":
    run_id, commit, tag = sys.argv[1:]
    if not run_id.isascii() or not run_id.isdigit():
        raise ValueError("Run ID must be numeric")
    repo = os.environ["GITHUB_REPOSITORY"]
    run = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}"))
    jobs = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100"))["jobs"]
    logs = {job["name"]: gh("api", "--allow-escape-sequences", f"repos/{repo}/actions/jobs/{job['id']}/logs")
            for job in jobs if job["name"] in {"release-windows", "release-linux", "release-ios"}}
    release_id = json.loads(gh("release", "view", tag, "--json", "databaseId"))["databaseId"]
    release = json.loads(gh("api", f"repos/{repo}/releases/{release_id}"))
    published = verify_retry(run, jobs, logs, release, commit, tag)
    print(f"ota-published={str(published).lower()}")

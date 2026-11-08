import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("retry", Path(__file__).parents[1] / "verify-release-retry.py")
retry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retry)


class ReleaseRetryTest(unittest.TestCase):
    def setUp(self):
        self.commit = "a" * 40
        self.run = {"path": ".github/workflows/release.yml"}
        self.jobs = [{"name": name, "conclusion": "success", "started_at": "2026-11-08T07:25:00Z", "completed_at": "2026-11-08T07:29:00Z"}
                     for name in ["release-windows", "release-linux", "release-ios"]]
        self.logs = {job["name"]: f"2026-11-08T07:25:01Z [command]/usr/bin/git log -1 --format=%H\n2026-11-08T07:25:02Z {self.commit}\n" for job in self.jobs}
        self.logs["release-windows"] = self.logs["release-windows"].replace("/usr/bin/git", '"C:\\Program Files\\Git\\bin\\git.exe"')
        self.release = {"draft": True, "assets": [{"name": name, "size": 100, "updated_at": "2026-11-08T07:28:00Z"} for name in [
            "Shuddhalekhan-Setup-4.7.0.exe", "Shuddhalekhan-Setup-4.7.0.exe.blockmap", "latest.yml",
            "shuddhalekhan-4.7.0-amd64.deb", "shuddhalekhan-4.7.0-x86_64.rpm", "latest-linux.yml", "Shuddhalekhan-unsigned.ipa"]]}

    def verify(self, commit=None):
        return retry.verify_retry(self.run, self.jobs, self.logs, self.release, commit or self.commit, "v4.7.0")

    def test_reuses_builds_and_preserves_successful_ota(self):
        self.assertFalse(self.verify())
        self.jobs.append({"name": "finalize", "steps": [{"name": "Publish OTA update", "conclusion": "success"}]})
        self.assertTrue(self.verify())

    def test_rejects_tag_moved_since_build(self):
        with self.assertRaisesRegex(ValueError, "different commit"):
            self.verify("b" * 40)

    def test_rejects_missing_desktop_installer(self):
        self.release["assets"].pop(0)
        with self.assertRaisesRegex(ValueError, "missing"):
            self.verify()

    def test_rejects_replaced_asset_after_build(self):
        for index in [0, -1]:
            with self.subTest(index=index):
                original = copy.deepcopy(self.release)
                self.release["assets"][index]["updated_at"] = "2026-11-08T07:30:00Z"
                with self.assertRaisesRegex(ValueError, "replaced"):
                    self.verify()
                self.release = original

    def test_rejects_failed_platform_build(self):
        self.jobs[0]["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "did not succeed"):
            self.verify()


if __name__ == "__main__":
    unittest.main()

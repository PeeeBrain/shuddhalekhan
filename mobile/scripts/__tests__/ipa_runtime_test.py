import importlib.util
import io
from pathlib import Path
import plistlib
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("runtime", Path(__file__).parents[1] / "read-ipa-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class IpaRuntimeTest(unittest.TestCase):
    def read(self, configured, fingerprint=None):
        contents = io.BytesIO()
        with zipfile.ZipFile(contents, "w") as ipa:
            ipa.writestr("Payload/Shuddhalekhan.app/Expo.plist", plistlib.dumps({"EXUpdatesRuntimeVersion": configured}))
            if fingerprint is not None:
                ipa.writestr("Payload/Shuddhalekhan.app/EXUpdates.bundle/fingerprint", fingerprint)
        contents.seek(0)
        with zipfile.ZipFile(contents) as ipa:
            return runtime.read_runtime(ipa)

    def test_resolves_bundled_fingerprint_instead_of_publishing_file_reference(self):
        fingerprint = "b27e121944ce38fa1ddd7c8fc08e5f81d86b78c4"
        self.assertEqual(self.read("file:fingerprint", fingerprint), fingerprint)

    def test_preserves_literal_runtime(self):
        self.assertEqual(self.read("4.7.0"), "4.7.0")

    def test_missing_fingerprint_stops_publication(self):
        with self.assertRaises(KeyError):
            self.read("file:fingerprint")

    def test_invalid_runtime_stops_publication(self):
        with self.assertRaises(ValueError):
            self.read("file:fingerprint", "not a valid runtime\nextra-output=value")


if __name__ == "__main__":
    unittest.main()

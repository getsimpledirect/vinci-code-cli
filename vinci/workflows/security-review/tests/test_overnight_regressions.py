"""New offline synthetic regressions with strict diagnostic-output checks.

No referenced source is opened, no endpoints are contacted, and no real secrets appear.
"""
import copy
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from validate_review import Invalid, load, validate

NOW = dt.datetime(2026, 10, 21, 19, 30, tzinfo=dt.timezone.utc)


class OvernightRegressions(unittest.TestCase):
    def setUp(self):
        self.doc = load(ROOT / "examples/synthetic-review.json")

    def run_cli(self, content):
        with tempfile.TemporaryDirectory(prefix="vinci-synthetic-input-") as directory:
            report = Path(directory) / "report.json"
            report.write_text(content)
            return subprocess.run(
                [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"), str(report), "--at", "2026-10-21T19:30:00Z"],
                capture_output=True, text=True, timeout=5,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )

    def assert_cli_rejected(self, content):
        result = self.run_cli(content)
        self.assertEqual(result.returncode, 2, "must reject with the documented exit code")
        self.assertEqual(json.loads(result.stdout)["contract_status"], "REJECTED")
        self.assertEqual(result.stderr, "", "rejection must not print a traceback")
        return result

    def consistent_path(self, path):
        self.doc["scope"]["allowed_paths"] = [path]
        self.doc["coverage"]["reviewed_paths"] = [path]
        self.doc["findings"][0]["evidence"]["path"] = path

    def test_missing_report_returns_documented_rejection(self):
        with tempfile.TemporaryDirectory(prefix="vinci-missing-report-") as directory:
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"), str(Path(directory) / "absent.json")],
                capture_output=True, text=True, timeout=5, env={"PATH": "/usr/bin:/bin"},
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["contract_status"], "REJECTED")

    def test_nested_duplicate_key_rejected(self):
        self.assert_cli_rejected('{"scope":{"owner":"SYNTHETIC one","owner":"SYNTHETIC two"}}')

    def test_empty_scope_allowlist_rejected(self):
        self.doc["scope"]["allowed_paths"] = []
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)

    def test_duplicate_scope_allowlist_rejected(self):
        self.doc["scope"]["allowed_paths"] *= 2
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)

    def test_duplicate_allowed_action_rejected(self):
        self.doc["scope"]["actions"] = ["read_source", "read_source"]
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)

    def test_propose_patch_without_read_permission_rejected(self):
        self.doc["scope"]["actions"] = ["propose_patch"]
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)

    def test_scope_expiry_equality_is_expired(self):
        self.doc["scope"]["expires_at"] = NOW.isoformat()
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)

    def test_nonexistent_source_is_not_read_or_attested(self):
        self.consistent_path("synthetic/not-a-real-file.py")
        self.assertFalse((ROOT / "synthetic/not-a-real-file.py").exists())
        result = validate(self.doc, NOW)
        self.assertEqual(result["contract_status"], "VALID_DECLARATION_ONLY")
        self.assertFalse(result["authorization_verified"])
        self.assertFalse(result["runtime_enforcement"])

    def test_duplicate_key_diagnostic_does_not_echo_sensitive_material(self):
        # Arbitrary duplicate-key bytes must stay out of diagnostic output.
        marker = "SYNTHETIC_DIAGNOSTIC_MARKER_73bQ9z"
        result = self.run_cli(json.dumps({marker: 0})[:-1] + "," + json.dumps(marker) + ":1}")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(marker, result.stdout + result.stderr, "untrusted key bytes must not be echoed into a report")

    def test_bounded_deep_json_has_structured_rejection(self):
        # 2.2 KiB only; no resource flood. Require structured fail-closed handling.
        self.assert_cli_rejected("[" * 1100 + "0" + "]" * 1100)


def malformed_test(content):
    def check(self):
        self.assert_cli_rejected(content)
    return check


for name, content in {
    "empty": "",
    "truncated_object": '{"schema_version":"1.1"',
    "trailing_document": '{} {}',
    "root_array": "[]",
    "root_scalar": "42",
    "nested_infinity": '{"nested":{"value":Infinity}}',
}.items():
    setattr(OvernightRegressions, "test_malformed_" + name, malformed_test(content))


def path_test(path):
    def check(self):
        self.consistent_path(path)
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)
    return check


for name, path in {
    "leading_dot": "./synthetic/file.py",
    "internal_dot": "synthetic/./file.py",
    "double_slash": "synthetic//file.py",
    "trailing_slash": "synthetic/file.py/",
    "backslash": "synthetic\\file.py",
    "interior_parent": "synthetic/../file.py",
}.items():
    setattr(OvernightRegressions, "test_consistent_path_" + name, path_test(path))


def unsupported_action_test(action):
    def check(self):
        self.doc["scope"]["actions"] = ["read_source", action]
        with self.assertRaises(Invalid):
            validate(self.doc, NOW)
    return check


for action in ["run_tests", "execute_shell", "read_credentials", "export_source", "apply_patch", "publish", "deploy"]:
    setattr(OvernightRegressions, "test_unsupported_action_" + action, unsupported_action_test(action))


class DiagnosticRegressions(unittest.TestCase):
    setUp = OvernightRegressions.setUp
    run_cli = OvernightRegressions.run_cli
    assert_cli_rejected = OvernightRegressions.assert_cli_rejected
    # Only new tests belong to this class; inherited packet cases are not repeated.
    def test_known_duplicate_key_names_contract_field(self):
        result = self.assert_cli_rejected('{"review_id":0,"review_id":1}')
        self.assertIn("review_id", json.loads(result.stdout)["reason"])

    def test_nested_reviewer_duplicate_names_contract_field(self):
        for key in ("type", "identity_ref"):
            with self.subTest(key=key):
                pair = json.dumps(key)
                result = self.assert_cli_rejected('{"reviewer":{' + pair + ':0,' + pair + ':1}}')
                self.assertIn(key, json.loads(result.stdout)["reason"])

    def test_unknown_nested_duplicate_key_does_not_echo_marker(self):
        marker = "SYNTHETIC_NESTED_MARKER_73bQ9z"
        pair = json.dumps(marker)
        result = self.assert_cli_rejected('{"scope":{' + pair + ':0,' + pair + ':1}}')
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_malformed_timestamp_does_not_echo_marker(self):
        marker = "SYNTHETIC_TIMESTAMP_MARKER_73bQ9z"
        self.doc["scope"]["issued_at"] = marker
        result = self.assert_cli_rejected(json.dumps(self.doc))
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_endpoint_port_does_not_echo_marker(self):
        marker = "SYNTHETIC_ENDPOINT_MARKER_73bQ9z"
        self.doc["route"] = {
            "mode": "hosted", "verification_state": "verified", "provider": "SYNTHETIC provider",
            "endpoint": "https://localhost:" + marker, "model": "synthetic-model", "requested_class": "synthetic-class",
            "approval_ref": "SYNTHETIC approval", "verification_ref": "SYNTHETIC receipt",
            "region": "synthetic-region", "retention": "synthetic-retention", "data_classes": ["synthetic"],
        }
        result = self.assert_cli_rejected(json.dumps(self.doc))
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_missing_report_does_not_echo_marker(self):
        marker = "SYNTHETIC_PATH_MARKER_73bQ9z"
        with tempfile.TemporaryDirectory(prefix="vinci-missing-report-") as directory:
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"), str(Path(directory) / marker)],
                capture_output=True, text=True, timeout=5,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["contract_status"], "REJECTED")
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_invalid_utf8_has_authored_reason(self):
        marker = "SYNTHETIC_ENCODING_MARKER_73bQ9z"
        with tempfile.TemporaryDirectory(prefix="vinci-encoding-") as directory:
            report = Path(directory) / "report.json"
            report.write_bytes(marker.encode() + bytes([255]))
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"), str(report)],
                capture_output=True, text=True, timeout=5,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["reason"], "report must contain valid UTF-8 text")
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_malformed_json_keeps_only_position(self):
        marker = "SYNTHETIC_JSON_MARKER_73bQ9z"
        result = self.assert_cli_rejected('{"' + marker + '":}')
        self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertRegex(json.loads(result.stdout)["reason"], r"^invalid JSON at line [0-9]+ column [0-9]+$")

    def test_nonfinite_number_has_authored_reason(self):
        result = self.assert_cli_rejected('{"SYNTHETIC_NONFINITE_MARKER_73bQ9z":NaN}')
        self.assertEqual(json.loads(result.stdout)["reason"], "non-finite JSON number")

    def test_unhashable_contract_value_has_authored_reason(self):
        marker = "SYNTHETIC_TYPE_MARKER_73bQ9z"
        self.doc["scope"]["data_class"] = {marker: 0}
        result = self.assert_cli_rejected(json.dumps(self.doc))
        self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["reason"], "invalid report value or structure")

    def test_positive_cli_declaration(self):
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"),
             str(ROOT / "examples/synthetic-review.json"), "--at", "2026-10-21T19:30:00Z"],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["contract_status"], "VALID_DECLARATION_ONLY")



class ReachabilityRegressions(unittest.TestCase):
    """Cases N08/N09 from the 2026-10-23 PR111 reachability packet (synthetic data), plus the output cap."""
    MARKER = "opaqueReachability739z"  # packet marker, fabricated text

    def run_validator(self, path):
        return subprocess.run(
            [sys.executable, "-I", "-S", str(ROOT / "tools/validate_review.py"), str(path)],
            capture_output=True, timeout=5, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )

    def test_n08_missing_report_excludes_supplied_path_bytes(self):
        with tempfile.TemporaryDirectory(prefix="vinci-synthetic-n08-") as directory:
            result = self.run_validator(Path(directory) / ("missing-" + self.MARKER + ".json"))
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(self.MARKER, result.stdout.decode())

    def test_n09_large_duplicate_key_output_is_bounded(self):
        large_key = self.MARKER + "q" * 8192
        with tempfile.TemporaryDirectory(prefix="vinci-synthetic-n09-") as directory:
            path = Path(directory) / "synthetic-large-duplicate.json"
            path.write_text("{" + json.dumps(large_key) + ":1," + json.dumps(large_key) + ":2}")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stdout), 1024)
        self.assertNotIn(self.MARKER, result.stdout.decode())

    def test_rejection_line_clamps_long_reasons(self):
        import validate_review
        for reason in ["x" * 8192, '"\\' * 3000, "\u00e9" * 3000, "fits"]:
            line = validate_review.rejection_line(reason)
            self.assertLessEqual(len((line + "\n").encode()), validate_review.MAX_OUTPUT_BYTES)
            self.assertEqual(json.loads(line)["contract_status"], "REJECTED")
        self.assertEqual(json.loads(validate_review.rejection_line("fits"))["reason"], "fits")
        self.assertTrue(json.loads(validate_review.rejection_line("x" * 8192))["reason"].endswith(" [truncated]"))

    def test_main_routes_rejections_through_the_clamp(self):
        import contextlib, io
        from unittest import mock
        import validate_review
        out = io.StringIO()
        with mock.patch.object(validate_review, "load", side_effect=Invalid("y" * 5000)), \
             mock.patch.object(sys, "argv", ["validate_review.py", "synthetic.json"]), contextlib.redirect_stdout(out):
            self.assertEqual(validate_review.main(), 2)
        self.assertLessEqual(len(out.getvalue().encode()), 1024)
        self.assertEqual(json.loads(out.getvalue())["contract_status"], "REJECTED")

if __name__ == "__main__":
    unittest.main(verbosity=2)

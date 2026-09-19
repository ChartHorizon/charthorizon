#!/usr/bin/env python3
"""Offline tests for the build-recipe fingerprint (app/packaging_fingerprint.py).

The Windows installer is built by hand in a VM that keeps its own copy of the tree, synced
with two robocopy calls -- one for app/, one for packaging/. Only the first was documented
for a long time, and a build from a stale packaging/ does not fail: it quietly follows the
previous recipe. That is how the ctypes.wintypes hidden import reached the Mac build and
never the Windows one, and how build_win.ps1's own guards went missing from the machine
they guard.

The chain that closes it: charthorizon.spec bakes the digest of the tree it is sitting in
into the bundle, start.py reports it from /api/version, and tools/packaging-fingerprint.py
prints what it ought to be from the live tree on the Mac. Two properties carry the whole
thing, and both are tested here -- the digest must move for every change that alters the
build, and must NOT move for anything else, because a digest that drifts on a typo is one
the operator learns to ignore.

No network, no running app.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from unittest import mock

import packaging_fingerprint as pf
import start
import yahoo_gateway

# Importing start.py installs the SERVER gateway profile as the process-wide singleton and
# points its lock_path at the real ff_data/refresh.lock; while a refresh is genuinely in
# flight that stands the gateway down and unrelated tests elsewhere in the suite fail. Hand
# the singleton back a plain profile, exactly as test_crash_recovery does.
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)

ROOT = os.path.dirname(os.path.abspath(__file__))                  # dashboard/app
PACKAGING = os.path.join(ROOT, os.pardir, "packaging")


class FingerprintTests(unittest.TestCase):
    """A miniature packaging/ tree, so the assertions do not move with the real recipe."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.tree = os.path.join(self.dir, "packaging")
        self._write("charthorizon.spec", "a = Analysis([])\n")
        self._write("build_icons.py", "print('icons')\n")
        self._write("windows/build_win.ps1", "param($Version)\n")
        self._write("windows/charthorizon.iss", "[Setup]\n")
        self._write("icons/icon.png", "not really a png")
        self._write("README.md", "how the recipes work\n")
        self._write("public/README.md", "the public readme\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, rel, text):
        path = os.path.join(self.tree, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def _digest(self):
        return pf.packaging_fingerprint(self.tree)

    # ── what must move it ──

    def test_editing_a_recipe_file_moves_the_digest(self):
        before = self._digest()
        self._write("windows/build_win.ps1", "param($Version)\n# a new guard\n")
        self.assertNotEqual(before, self._digest())

    def test_a_new_hidden_import_in_the_spec_moves_the_digest(self):
        # The concrete case: 1.2.3's liveness fix needed ctypes.wintypes in the spec, and
        # the VM never got it.
        before = self._digest()
        self._write("charthorizon.spec", "a = Analysis([], hiddenimports=['ctypes.wintypes'])\n")
        self.assertNotEqual(before, self._digest())

    def test_renaming_a_recipe_file_moves_the_digest(self):
        before = self._digest()
        os.rename(os.path.join(self.tree, "build_icons.py"),
                  os.path.join(self.tree, "make_icons.py"))
        self.assertNotEqual(before, self._digest(),
                            "names are hashed too, or a rename would slip through")

    def test_deleting_a_recipe_file_moves_the_digest(self):
        before = self._digest()
        os.unlink(os.path.join(self.tree, "windows", "charthorizon.iss"))
        self.assertNotEqual(before, self._digest())

    # ── what must NOT move it ──

    def test_icons_and_documentation_leave_the_digest_alone(self):
        # build_icons.py regenerates packaging/icons/ during the build, so hashing it would
        # make the digest depend on its own output; the .md files change nothing about the
        # binary. A digest that moves on a typo is one nobody checks.
        before = self._digest()
        self._write("icons/icon.png", "a freshly generated png")
        self._write("README.md", "how the recipes work, now with a typo fixed\n")
        self._write("public/README.md", "a new public readme\n")
        self.assertEqual(before, self._digest())

    def test_the_same_tree_at_another_path_has_the_same_digest(self):
        # The Mac hashes dashboard/packaging, the VM hashes C:\\ch\\packaging. Only the
        # relative layout may count, or the two could never agree.
        other = os.path.join(self.dir, "elsewhere", "packaging")
        shutil.copytree(self.tree, other)
        self.assertEqual(self._digest(), pf.packaging_fingerprint(other))

    def test_the_digest_is_stable_across_calls(self):
        self.assertEqual(self._digest(), self._digest())

    def test_the_real_tree_yields_a_short_readable_digest(self):
        d = pf.packaging_fingerprint(PACKAGING)
        self.assertEqual(len(d), 12)
        self.assertTrue(all(c in "0123456789abcdef" for c in d))


class ReportedRecipeTests(unittest.TestCase):
    """start.packaging_recipe() -- the value /api/version hands the operator."""

    def test_a_source_run_reports_the_live_recipe(self):
        # This is what makes the chain testable without building an installer: a dev run
        # reports exactly what a correct build of this checkout would bake.
        self.assertEqual(start.packaging_recipe(), pf.packaging_fingerprint(PACKAGING))

    def test_a_frozen_build_reports_the_baked_digest(self):
        bundle = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, bundle, True)
        with open(os.path.join(bundle, pf.FINGERPRINT_FILE), "w", encoding="utf-8") as f:
            f.write("abc123abc123\n")
        with mock.patch.object(start, "FROZEN", True), \
                mock.patch.object(start, "APP_DIR", bundle):
            self.assertEqual(start.packaging_recipe(), "abc123abc123")

    def test_a_bundle_without_the_baked_file_reports_none(self):
        # Older installers carry no such file. None is honest; it must not raise and take
        # /api/version -- and with it the whole About card -- down with it.
        bundle = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, bundle, True)
        with mock.patch.object(start, "FROZEN", True), \
                mock.patch.object(start, "APP_DIR", bundle):
            self.assertIsNone(start.packaging_recipe())

    def test_the_version_payload_carries_it(self):
        self.assertIn("packaging", start.version_payload())


class SpecBakesItTests(unittest.TestCase):
    """If the spec stops baking the file, every installer reports None and the check goes
    quiet without failing -- the one way this whole chain can rot unnoticed."""

    def _spec(self):
        with open(os.path.join(PACKAGING, "charthorizon.spec"), "r", encoding="utf-8") as f:
            return f.read()

    def test_the_spec_computes_the_digest(self):
        self.assertIn("packaging_fingerprint(", self._spec())

    def test_the_spec_ships_the_baked_file_in_datas(self):
        src = self._spec()
        self.assertIn("FINGERPRINT_FILE", src)
        self.assertIn("datas += [(_fp_path,", src)


if __name__ == "__main__":
    unittest.main()

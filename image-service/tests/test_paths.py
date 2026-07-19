"""Unit tests for services.paths (2026-07 audit, for #202)."""

from __future__ import annotations

from pathlib import Path

from services.paths import reserve_filename, safe_child_path, sanitize_upload_filename

# ------------------------- safe_child_path -------------------------


def test_contained_name_resolves(tmp_path: Path):
    got = safe_child_path(str(tmp_path), "esp_capture_20260719_120000.jpg")
    assert got == str(tmp_path / "esp_capture_20260719_120000.jpg")


def test_traversal_is_rejected(tmp_path: Path):
    (tmp_path / "sub").mkdir()
    assert safe_child_path(str(tmp_path / "sub"), "../escape.jpg") is None
    assert safe_child_path(str(tmp_path / "sub"), "../../etc/passwd") is None


def test_absolute_path_is_rejected(tmp_path: Path):
    assert safe_child_path(str(tmp_path), "/etc/passwd") is None


def test_base_dir_itself_is_rejected(tmp_path: Path):
    assert safe_child_path(str(tmp_path), ".") is None
    assert safe_child_path(str(tmp_path), "") is None


def test_symlink_escape_is_rejected(tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    base = tmp_path / "base"
    base.mkdir()
    (base / "link").symlink_to(outside)
    assert safe_child_path(str(base), "link/x.jpg") is None


# --------------------- sanitize_upload_filename ---------------------


def test_fleet_grammar_names_pass_byte_identical():
    # The two shapes ESP32-CAM/client.cpp's createFileName produces.
    for name in (
        "esp_capture_20260719_120000.jpg",
        "esp_capture_unknown_123456.jpg",
    ):
        assert sanitize_upload_filename(name) == name


def test_traversal_and_separators_are_stripped():
    assert sanitize_upload_filename("../../evil.jpg") == "evil.jpg"
    assert sanitize_upload_filename("a/b/c.jpg") == "c.jpg"
    assert sanitize_upload_filename("..\\..\\evil.jpg") == "evil.jpg"


def test_disallowed_chars_become_underscores():
    assert sanitize_upload_filename("a b;c$.jpg") == "a_b_c_.jpg"


def test_leading_dots_are_stripped():
    assert sanitize_upload_filename(".hidden.jpg") == "hidden.jpg"


def test_empty_and_hostile_only_fall_back():
    assert sanitize_upload_filename(None) == "upload.jpg"
    assert sanitize_upload_filename("") == "upload.jpg"
    assert sanitize_upload_filename("../..") == "upload.jpg"


def test_overlong_name_keeps_tail_and_extension():
    got = sanitize_upload_filename("a" * 500 + ".jpg")
    assert len(got) <= 120
    assert got.endswith(".jpg")


# -------------------------- reserve_filename --------------------------


def test_no_collision_returns_name_and_reserves_it(tmp_path: Path):
    assert reserve_filename(str(tmp_path), "x.jpg") == "x.jpg"
    # Reservation is atomic-by-creation: the placeholder now exists, so a
    # concurrent reserver can never resolve to the same name.
    assert (tmp_path / "x.jpg").exists()


def test_collision_appends_suffix_before_extension(tmp_path: Path):
    (tmp_path / "x.jpg").write_bytes(b"1")
    assert reserve_filename(str(tmp_path), "x.jpg") == "x-1.jpg"
    # The x-1.jpg placeholder was created by the reservation itself, so
    # the next reserver skips straight to -2 without any caller write.
    assert reserve_filename(str(tmp_path), "x.jpg") == "x-2.jpg"


def test_collision_without_extension(tmp_path: Path):
    (tmp_path / "noext").write_bytes(b"1")
    assert reserve_filename(str(tmp_path), "noext") == "noext-1"

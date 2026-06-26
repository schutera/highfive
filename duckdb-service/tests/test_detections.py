"""Tests for the nest-detection persistence routes (#165).

Asserts behaviour, not just envelope shape: a recorded detection actually lands
and reads back with its state/bbox, and the read folds to the *latest* snip per
nest (the dashboard contract). Per CLAUDE.md aggregation rule, we seed real rows
and assert they appear — not that the response merely has a `detections` key.
"""

from __future__ import annotations

TEST_MAC = "aabbccddeeff"


def _detection(bee_type: str, nest_index: int, state: str, snip: str) -> dict:
    return {
        "bee_type": bee_type,
        "nest_index": nest_index,
        "bbox": [0.1, 0.2, 0.3, 0.3],
        "state": state,
        "confidence": 0.8,
        "snip_filename": snip,
    }


def test_record_and_read_back_detections(client):
    resp = client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "cap.jpg",
            "detections": [
                _detection("leafcutter", 1, "sealed", "cap-leafcutter-1.jpg"),
                _detection("leafcutter", 2, "empty", "cap-leafcutter-2.jpg"),
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["inserted"] == 2

    read = client.get(f"/detections?module_id={TEST_MAC}")
    assert read.status_code == 200
    dets = read.get_json()["detections"]
    assert len(dets) == 2
    by_nest = {d["nest_index"]: d for d in dets}
    assert by_nest[1]["state"] == "sealed"
    assert by_nest[1]["snip_filename"] == "cap-leafcutter-1.jpg"
    assert by_nest[1]["bbox"] == [0.1, 0.2, 0.3, 0.3]
    assert by_nest[2]["state"] == "empty"


def test_read_returns_only_the_latest_capture(client):
    """The grid reflects the most recent capture: a newer upload's snips win."""
    client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "old.jpg",
            "detections": [_detection("orchard", 1, "empty", "old-orchard-1.jpg")],
        },
    )
    client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "new.jpg",
            "detections": [_detection("orchard", 1, "sealed", "new-orchard-1.jpg")],
        },
    )
    dets = client.get(f"/detections?module_id={TEST_MAC}").get_json()["detections"]
    orchard = [d for d in dets if d["bee_type"] == "orchard"]
    assert len(orchard) == 1
    assert orchard[0]["state"] == "sealed"
    assert orchard[0]["snip_filename"] == "new-orchard-1.jpg"


def test_vanished_nest_does_not_latch_a_stale_snip(client):
    """A nest the *latest* capture didn't detect must disappear, not serve an
    old crop. The learned detector's per-row hole count varies ±1 frame-to-frame
    (ADR-027); a per-nest "latest snip" fold would latch capA's nest 2 forever
    once capB detects fewer holes. This pins the latest-capture fold instead."""
    # Capture A: orchard has TWO nests.
    client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "capA.jpg",
            "detections": [
                _detection("orchard", 1, "sealed", "capA-orchard-1.jpg"),
                _detection("orchard", 2, "sealed", "capA-orchard-2.jpg"),
            ],
        },
    )
    # Capture B (newer): the model only found ONE orchard hole this frame.
    client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "capB.jpg",
            "detections": [_detection("orchard", 1, "empty", "capB-orchard-1.jpg")],
        },
    )
    dets = client.get(f"/detections?module_id={TEST_MAC}").get_json()["detections"]
    # Only capB's snips — capA's stale nest 2 is gone, not latched.
    assert all(d["filename"] == "capB.jpg" for d in dets), dets
    orchard = [d for d in dets if d["bee_type"] == "orchard"]
    assert len(orchard) == 1
    assert orchard[0]["snip_filename"] == "capB-orchard-1.jpg"


def test_undetermined_state_is_recorded(client):
    """The learned detector (ADR-027) emits ``undetermined`` (it localizes but
    defers empty/sealed); that state must persist and read back, not be skipped."""
    resp = client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "loc.jpg",
            "detections": [
                _detection("blackmasked", 1, "undetermined", "loc-blackmasked-1.jpg"),
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["inserted"] == 1
    dets = client.get(f"/detections?module_id={TEST_MAC}").get_json()["detections"]
    assert [d["state"] for d in dets] == ["undetermined"]


def test_reupload_same_capture_is_idempotent(client):
    """A retried upload re-records the same capture (record_detections is
    append-only, no DELETE). The read must still return ONE row per nest — the
    latest-capture scope alone would return both copies as duplicate grid cells
    (and React key collisions); the per-nest dedup keeps it idempotent."""
    payload = {
        "module_id": TEST_MAC,
        "filename": "retry.jpg",
        "detections": [
            _detection("leafcutter", 1, "sealed", "retry-leafcutter-1.jpg"),
            _detection("leafcutter", 2, "empty", "retry-leafcutter-2.jpg"),
        ],
    }
    # Same capture recorded twice (network-retry duplicate).
    client.post("/record_detections", json=payload)
    client.post("/record_detections", json=payload)

    dets = client.get(f"/detections?module_id={TEST_MAC}").get_json()["detections"]
    # One row per nest, not two — no duplicates despite the double-record.
    nests = sorted(d["nest_index"] for d in dets)
    assert nests == [1, 2], nests
    assert len(dets) == 2


def test_invalid_state_rows_are_skipped_not_fatal(client):
    resp = client.post(
        "/record_detections",
        json={
            "module_id": TEST_MAC,
            "filename": "mix.jpg",
            "detections": [
                _detection("resin", 1, "sealed", "mix-resin-1.jpg"),
                _detection("resin", 2, "bogus-state", "mix-resin-2.jpg"),
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["inserted"] == 1


def test_record_requires_fields(client):
    assert (
        client.post("/record_detections", json={"filename": "x.jpg"}).status_code == 400
    )
    assert (
        client.post("/record_detections", json={"module_id": TEST_MAC}).status_code
        == 400
    )


def test_read_requires_module_id(client):
    assert client.get("/detections").status_code == 400


def test_read_empty_module_returns_empty_list(client):
    resp = client.get(f"/detections?module_id={TEST_MAC}")
    assert resp.status_code == 200
    assert resp.get_json()["detections"] == []


def test_invalid_module_id_is_400(client):
    assert client.get("/detections?module_id=not-a-mac").status_code == 400

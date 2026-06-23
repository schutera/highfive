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


def test_read_folds_to_latest_snip_per_nest(client):
    """Two uploads for the same nest => the read returns only the newest."""
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

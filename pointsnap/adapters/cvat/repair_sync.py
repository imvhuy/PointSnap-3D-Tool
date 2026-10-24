"""Verify geometry writes against CVAT's authoritative annotations."""

import copy
import math

from pointsnap.adapters.cvat.client import CvatError


def same_track(a, b):
    def canonical(track):
        result = copy.deepcopy(track)
        def attributes(obj):
            obj["attributes"] = sorted(obj.get("attributes", []),
                                       key=lambda a: (str(a.get("spec_id", a.get("id", ""))), str(a.get("name", ""))))
        attributes(result)
        # CVAT can regenerate shape IDs during a track update.
        for shape in result.get("shapes", []):
            shape.pop("id", None)
            shape.pop("keyframe", None)
            attributes(shape)
        result.pop("label", None)
        result["shapes"] = sorted(result.get("shapes", []), key=lambda s: s["frame"])
        return result

    def equal(x, y):
        if isinstance(x, dict) and isinstance(y, dict):
            return x.keys() == y.keys() and all(equal(x[k], y[k]) for k in x)
        if isinstance(x, list) and isinstance(y, list):
            return len(x) == len(y) and all(equal(i, j) for i, j in zip(x, y))
        if isinstance(x, (float, int)) and isinstance(y, (float, int)):
            return math.isclose(x, y, rel_tol=1e-7, abs_tol=1e-6)
        return x == y

    return equal(canonical(a), canonical(b))


def write_verified_track(client, job_id, before, after):
    fresh = client.get_job_annotations(job_id)
    current = next((t for t in fresh.get("tracks", []) if t.get("id") == before["id"]), None)
    if current is None or not same_track(current, before):
        from pointsnap.adapters.cvat.writer import OCCConflictError
        raise OCCConflictError("Track đã thay đổi trước khi ghi; hãy tải lại đề xuất")
    payload = {"tracks": [after]}
    if "version" in fresh:
        payload["version"] = fresh["version"]
    client.patch_job_annotations(job_id, payload, action="update")
    actual = client.get_job_annotations(job_id)
    stored = next((t for t in actual.get("tracks", []) if t.get("id") == after["id"]), None)
    if stored is None or not same_track(stored, after):
        raise CvatError("CVAT chưa xác nhận đúng dữ liệu sau ghi; hãy tải lại nhãn để kiểm tra")
    return stored

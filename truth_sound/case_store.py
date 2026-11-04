"""사건 폴더: 원본 사본(읽기 전용), case.json, 작업 파일."""
import json
import os
import re
import secrets
import shutil
import stat
import threading
import copy
from datetime import datetime
from pathlib import Path

import numpy as np

from . import config, editing
from .analysis import CLIP_LEVEL
from .audio_io import load_audio, probe, write_wav
from .integrity import sha256_file

DEFAULT_SPEAKERS = [("me", "나"), ("partner", "상대방"), ("bystander", "옆 사람")]
MAX_SPEAKERS = 3

_lock = threading.RLock()


class Conflict(Exception):
    """지금 상태에서는 할 수 없는 일(사건 치우기 등). 메시지는 사용자에게 그대로 보인다."""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def safe_name(name: str, fallback: str = "recording") -> str:
    base = Path(name.replace("\\", "/")).name
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip(" .")
    return base or fallback


def case_dir(case_id: str) -> Path:
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{4}", case_id):
        raise ValueError("잘못된 사건 번호입니다.")
    return config.cases_dir() / case_id


def load_case(case_id: str) -> dict:
    with open(case_dir(case_id) / "case.json", encoding="utf-8") as f:
        return json.load(f)


def save_case(case_id: str, data: dict) -> None:
    path = case_dir(case_id) / "case.json"
    tmp = path.with_suffix(".json.tmp")
    with _lock:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)


def create_case(src: Path, display_name: str, client_mtime: float | None) -> str:
    case_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    d = case_dir(case_id)
    for sub in ("original", "work", "tracks", "exports"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    name = safe_name(display_name, "recording" + Path(src).suffix)
    orig = d / "original" / name
    shutil.copyfile(src, orig)
    os.chmod(orig, stat.S_IREAD)
    info = probe(orig)
    listen_sr = max(8000, min(int(info["sample_rate"] or 16000), 48000))
    listen = load_audio(orig, listen_sr)
    write_wav(d / "work" / "listen.wav", listen, listen_sr)
    # 듣기용 사본에서 꼭대기에 붙은(잘린) 표본의 비율을 구한다
    clipped = round(100.0 * float(np.count_nonzero(np.abs(listen) >= CLIP_LEVEL)) / max(len(listen), 1), 3)
    data = {
        "id": case_id,
        "created_at": now_iso(),
        "original": {
            "name": name,
            "path": f"original/{name}",
            "size": orig.stat().st_size,
            "sha256": sha256_file(orig),
            "client_mtime": client_mtime,
            "probe": info,
            "clipped_percent": clipped,
        },
        "speakers": [{"id": i, "name": n, "enroll": []} for i, n in DEFAULT_SPEAKERS],
        "status": "new",
        "processing": None,
        "edits": editing.empty_edits(),
        "log": [{"at": now_iso(), "event": "원본 등록", "name": name}],
    }
    save_case(case_id, data)
    return case_id


def list_cases() -> list[dict]:
    out = []
    for p in config.cases_dir().iterdir():
        f = p / "case.json"
        if not f.exists():
            continue
        c = json.loads(f.read_text(encoding="utf-8"))
        # 예전 사건은 probe.duration이 없을 수 있다
        source_duration = c["original"].get("probe", {}).get("duration")
        duration = (editing.summary(c)["duration"] if source_duration is not None else None)
        out.append({"id": c["id"], "created_at": c["created_at"],
                    "name": c["original"]["name"], "status": c["status"],
                    "duration": duration})
    return sorted(out, key=lambda c: c["created_at"], reverse=True)


def same_sha(sha256: str, exclude: str) -> list[str]:
    """같은 녹음(해시가 같은 원본)을 가진 다른 사건 번호들, 최신순."""
    out = []
    for p in config.cases_dir().iterdir():
        f = p / "case.json"
        if not f.exists():
            continue
        c = json.loads(f.read_text(encoding="utf-8"))
        if c["id"] != exclude and c["original"].get("sha256") == sha256:
            out.append((c["created_at"], c["id"]))
    return [i for _, i in sorted(out, reverse=True)]


def remove_new_case(case_id: str) -> Path:
    """아직 아무것도 하지 않은 새 사건만 removed_dir로 옮긴다. 파일은 지우지 않는다."""
    with _lock:
        d = case_dir(case_id)
        case = load_case(case_id)
        if (case["status"] != "new" or any(s.get("enroll") for s in case["speakers"])
                or (d / "transcript.json").exists()):
            raise Conflict("샘플을 넣었거나 처리한 사건은 치울 수 없습니다.")
        dest = config.removed_dir() / case_id
        if dest.exists():
            raise Conflict("치운 사건 폴더에 같은 번호가 이미 있습니다.")
        os.replace(d, dest)
        return dest


def set_speakers(case_id: str, speakers: list[dict]) -> list[dict]:
    with _lock:
        case = load_case(case_id)
        duration = float(case["original"]["probe"]["duration"])
        cuts = editing.cuts_from_edits(editing.edit_state(case), duration)
        edit_duration = editing.edited_duration(duration, cuts)
        if not 1 <= len(speakers) <= MAX_SPEAKERS:
            raise ValueError(f"화자는 1~{MAX_SPEAKERS}명까지 지정할 수 있습니다.")
        clean, seen = [], set()
        for s in speakers:
            sid = str(s.get("id", ""))
            if not re.fullmatch(r"[a-z0-9_-]{1,32}", sid) or sid in seen:
                raise ValueError("화자 id가 잘못되었거나 겹칩니다.")
            if sid == "unknown":  # 받아쓰기의 '화자 확인 필요' 줄에 쓴다
                raise ValueError("'unknown'은 쓸 수 없는 화자 id입니다.")
            if sid == "orig":  # 편집 화면의 원본 트랙 id
                raise ValueError("'orig'는 쓸 수 없는 화자 id입니다.")
            seen.add(sid)
            name = str(s.get("name", "")).strip()
            if not name:
                raise ValueError("화자 이름을 입력하세요.")
            enroll = []
            for rng in s.get("enroll", []):
                a, b = float(rng[0]), float(rng[1])
                if not (0 <= a < b <= edit_duration + 0.05):
                    raise ValueError(f"{name}: 구간 {a:.2f}~{b:.2f}초가 잘못되었습니다.")
                enroll.extend(editing.edited_range_to_source(a, min(b, edit_duration), duration, cuts))
            enroll = editing.merge_ranges(enroll, duration)
            clean.append({"id": sid, "name": name[:40], "enroll": enroll})
        case["speakers"] = clean
        save_case(case_id, case)
        return public_speakers(case)[0]


def public_speakers(case: dict) -> tuple[list[dict], list[str]]:
    """저장된 원본 좌표 샘플을 현재 편집 좌표로 바꾼다."""
    duration = float(case["original"]["probe"]["duration"])
    cuts = editing.cuts_from_edits(editing.edit_state(case), duration)
    out, review = [], []
    for speaker in case.get("speakers", []):
        item = {k: copy.deepcopy(v) for k, v in speaker.items() if k != "enroll"}
        enroll = []
        for source_range in speaker.get("enroll", []):
            projected = editing.project_interval([source_range], duration, cuts)
            enroll.extend(projected["ranges"])
            if projected["partial"]:
                review.append(speaker["id"])
        item["enroll"] = editing.merge_ranges(enroll)
        out.append(item)
    return out, sorted(set(review))


def public_case(case: dict) -> dict:
    """API용 복사본. 구버전 사건도 edits가 없는 무편집 사건으로 연다."""
    out = copy.deepcopy(case)
    out["speakers"], review = public_speakers(case)
    out["edit"] = editing.summary(case)
    out["edit"]["sample_review"] = review
    out["original"]["probe"]["source_duration"] = case["original"]["probe"]["duration"]
    out["original"]["probe"]["duration"] = out["edit"]["duration"]
    out.pop("edits", None)
    return out


def verify_original(case_id: str) -> dict:
    case = load_case(case_id)
    expected = case["original"]["sha256"]
    path = case_dir(case_id) / case["original"]["path"]
    actual = sha256_file(path) if path.exists() else None
    return {"ok": actual == expected, "expected": expected, "actual": actual, "checked_at": now_iso()}


def append_log(case_id: str, event: str, **details) -> None:
    with _lock:
        case = load_case(case_id)
        case["log"].append({"at": now_iso(), "event": event, **details})
        save_case(case_id, case)

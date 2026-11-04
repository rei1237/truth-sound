"""브라우저 화면이 쓰는 로컬 API. 127.0.0.1에서만 연다."""
import contextlib
import json
import os
import re
import shutil
import tempfile
import threading
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import analysis, case_store, config, editing, export
from .pipeline import run_pipeline, run_transcribe
from .transcript import EXCLUDE_REASONS

STATIC = Path(__file__).parent / "static"
MANUAL_ID = re.compile(r"m[0-9a-f]{8}")
MEMORY_HINTS = ("out of memory", "cublas", "mkl_malloc", "memoryerror", "paging file", "bad_alloc",
                "allocate")


def _friendly(e: BaseException) -> str:
    text = f"{type(e).__name__}: {e}" if not str(e) else str(e)
    if isinstance(e, MemoryError) or any(h in text.lower() for h in MEMORY_HINTS):
        return f"메모리가 부족합니다. 다른 프로그램을 닫고 다시 시도하세요. ({text})"
    return text


EDIT_BLOCKING = ("process", "transcribe")  # 이 종류의 작업이 도는 동안은 그 사건의 화자·녹취록을 고칠 수 없다


class Jobs:
    """작업은 종류(process·transcribe·clarify)와 상관없이 한 번에 하나만 돈다. 화면은 current()를 주기적으로 읽어 진행 상황을 보여 준다."""

    def __init__(self, pipeline_fn):
        self.pipeline_fn = pipeline_fn
        self.lock = threading.Lock()
        self.state = {"case_id": None, "kind": None, "speaker": None, "step": None,
                      "stage": "", "progress": 0.0, "message": "", "state": "idle"}

    def current(self) -> dict:
        with self.lock:
            return dict(self.state)

    def running(self, case_id: str | None = None, kinds: tuple[str, ...] | None = None) -> bool:
        with self.lock:
            return (self.state["state"] == "running" and case_id in (None, self.state["case_id"])
                    and (kinds is None or self.state["kind"] in kinds))

    def start(self, case_id: str, kind: str = "process", fn=None, speaker: str | None = None,
              step: str | None = None) -> bool:
        with self.lock:
            if self.state["state"] == "running":
                return False
            self.state = {"case_id": case_id, "kind": kind, "speaker": speaker, "step": step, "stage": "대기",
                          "progress": 0.0, "message": "곧 시작합니다", "state": "running"}
        threading.Thread(target=self._work, args=(fn or self.pipeline_fn, case_id), daemon=True).start()
        return True

    def _progress(self, stage: str, p: float, message: str) -> None:
        with self.lock:
            self.state.update(stage=stage, progress=round(float(p), 4), message=message)

    def _work(self, fn, case_id: str) -> None:
        try:
            fn(case_id, self._progress)
        except BaseException as e:  # 화면에 알려야 하므로 모든 실패를 잡는다
            traceback.print_exc()
            with self.lock:
                self.state.update(state="error", message=_friendly(e))
            return
        with self.lock:
            self.state.update(state="done", progress=1.0, message="처리가 끝났습니다")


class SameOriginOnly:
    """다른 사이트가 브라우저를 시켜 이 로컬 서버에 처리·수정 요청을 보내지 못하게 한다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] not in ("GET", "HEAD"):
            headers = dict(scope["headers"])
            origin = headers.get(b"origin")
            if origin is not None and origin != b"http://" + headers.get(b"host", b""):
                await JSONResponse({"detail": "다른 사이트에서 보낸 요청은 받지 않습니다."}, status_code=403)(
                    scope, receive, send)
                return
        await self.app(scope, receive, send)


class NoStoreStatic:
    """로컬 앱 업데이트 뒤 예전 JS 모듈이 남지 않게 정적 응답 캐시를 막는다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def no_store(message):
            if (scope["type"] == "http" and not scope.get("path", "").startswith("/api/")
                    and message["type"] == "http.response.start"):
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                message = {**message, "headers": headers + [(b"cache-control", b"no-store")]}
            await send(message)
        await self.app(scope, receive, no_store)


def _case_path(case_id: str) -> Path:
    try:
        d = case_store.case_dir(case_id)
    except ValueError:
        raise HTTPException(404, "사건을 찾을 수 없습니다.")
    if not (d / "case.json").exists():
        raise HTTPException(404, "사건을 찾을 수 없습니다.")
    return d


def _read_transcript(d: Path) -> dict:
    path = d / "transcript.json"
    if not path.exists():
        raise HTTPException(404, "아직 녹취록이 없습니다. 먼저 처리하세요.")
    return json.loads(path.read_text(encoding="utf-8"))


def _public_transcript(case_id: str, data: dict | None = None) -> dict:
    case = case_store.load_case(case_id)
    duration = float(case["original"]["probe"]["duration"])
    cuts = editing.cuts_from_edits(editing.edit_state(case), duration)
    raw = data if data is not None else _read_transcript(case_store.case_dir(case_id))
    out = dict(raw)
    out["entries"] = editing.project_entries(raw.get("entries", []), duration, cuts)
    out["edit_revision"] = editing.summary(case)["revision"]
    return out


def _counts(entries: list[dict]) -> dict:
    return {"reviewed": sum(1 for e in entries if e["reviewed"]), "total": len(entries),
            "excluded": sum(1 for e in entries if e.get("excluded"))}


class PoolBlocked(Exception):
    """처리가 돌거나 시작하는 중이라 화자 모델을 올리거나 쓸 수 없다."""


class EncoderPool:
    """화자 모델은 무거워서 처음 필요할 때 올리고, 한동안 안 쓰면 내린다(처리가 메모리를 쓰기 전에도 내린다).
    use()로 쓰는 동안에는 유휴 타이머도 close()도 모델을 내리지 못한다(close()는 쓰기가 끝나길 기다린다).
    close()·exclusive()가 기다리거나 blocked()가 참인 동안 새 use()는 PoolBlocked로 거절한다."""

    def __init__(self, factory, idle_sec: float, blocked=None):
        self.factory = factory
        self.idle_sec = idle_sec
        self.blocked = blocked
        self.closing = 0
        self.lock = threading.Condition()
        self.encoder = None
        self.timer = None
        self.in_use = 0

    def _arm(self) -> None:
        if self.timer is not None:
            self.timer.cancel()
        timer = threading.Timer(self.idle_sec, lambda: self._idle(timer))  # 걸릴 때의 타이머를 기억한다
        timer.daemon = True
        self.timer = timer
        timer.start()

    def get(self):
        with self.lock:
            if self.encoder is None:
                self.encoder = self.factory()
            self._arm()
            return self.encoder

    @contextlib.contextmanager
    def use(self):
        """모델을 쓰는 동안 붙잡는다. 끝나면 유휴 타이머를 다시 건다."""
        with self.lock:
            if self.closing or (self.blocked and self.blocked()):  # 모델을 올리기 전에, 락 안에서 본다
                raise PoolBlocked()
            enc = self.get()
            self.in_use += 1
            self.timer.cancel()
        try:
            yield enc
        finally:
            with self.lock:
                self.in_use -= 1
                self._arm()
                self.lock.notify_all()

    def _idle(self, timer) -> None:
        with self.lock:
            if timer is not self.timer or self.in_use:  # 그 사이 새로 걸렸거나 쓰는 중이면 내리지 않는다
                return
            self._drop()

    def _drop(self) -> None:
        """락을 쥔 채 부른다."""
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None
        enc, self.encoder = self.encoder, None
        if enc is not None:
            enc.close()

    @contextlib.contextmanager
    def exclusive(self):
        """쓰는 중인 것이 끝나길 기다려 모델을 내리고, 블록이 끝날 때까지 새 use()를 막는다.
        처리 시작은 이 안에서 jobs.start()까지 해서, 내린 뒤 시작 전 틈에 모델이 다시 올라오지 못하게 한다."""
        with self.lock:
            self.closing += 1
            try:
                while self.in_use:
                    self.lock.wait()
                self._drop()
            except BaseException:
                self.closing -= 1
                raise
        try:
            yield
        finally:
            with self.lock:
                self.closing -= 1

    def close(self) -> None:
        with self.exclusive():
            pass


def _default_encoder():
    from .separate import SpeakerEncoder  # 모델을 내려받고 올리는 무거운 들여오기라 처음 쓸 때만
    return SpeakerEncoder()


def create_app(pipeline_fn=run_pipeline, encoder_factory=None, encoder_idle_sec: float = 60.0,
               transcribe_fn=run_transcribe, clarify_fn=None) -> FastAPI:
    app = FastAPI(title="Truth Sound")
    app.add_middleware(NoStoreStatic)
    app.add_middleware(SameOriginOnly)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])  # DNS 리바인딩 차단
    jobs = Jobs(pipeline_fn)
    app.state.jobs = jobs
    pool = EncoderPool(encoder_factory or _default_encoder, encoder_idle_sec, blocked=lambda: jobs.running())
    app.state.encoders = pool

    @app.exception_handler(ValueError)
    async def _bad_request(request: Request, e: ValueError):
        return JSONResponse({"detail": str(e)}, status_code=400)

    @app.get("/api/cases")
    def list_cases():
        return case_store.list_cases()

    @app.post("/api/cases")
    def upload(file: UploadFile = File(...), client_mtime: float | None = Form(None)):
        tmp_dir = config.app_home() / "data" / "upload"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=tmp_dir, suffix=Path(file.filename or "").suffix)
        try:
            with os.fdopen(fd, "wb") as f:
                shutil.copyfileobj(file.file, f, 1024 * 1024)
            try:
                cid = case_store.create_case(Path(tmp), file.filename or "recording", client_mtime)
            except Exception as e:
                raise HTTPException(400, f"녹음 파일을 열 수 없습니다: {e}")
        finally:
            os.unlink(tmp)
        sha = case_store.load_case(cid)["original"]["sha256"]
        return {"id": cid, "same": case_store.same_sha(sha, cid)}

    @app.delete("/api/cases/{case_id}")
    def delete_case(case_id: str):
        _case_path(case_id)
        if jobs.running(case_id):
            raise HTTPException(409, "처리 중인 사건은 치울 수 없습니다.")
        try:
            case_store.remove_new_case(case_id)
        except case_store.Conflict as e:
            raise HTTPException(409, str(e))
        except OSError:
            # Windows: 미리 듣기가 녹음 파일을 잡고 있으면 폴더를 옮길 수 없다(PermissionError). 사건은 그대로 남다.
            raise HTTPException(409, "녹음 파일을 읽는 중이라 지금은 치울 수 없습니다. 잠시 뒤 다시 누르세요.")
        return {"ok": True}

    @app.get("/api/cases/{case_id}")
    def get_case(case_id: str):
        d = _case_path(case_id)
        case = case_store.load_case(case_id)
        case["has_transcript"] = (d / "transcript.json").exists()
        return case_store.public_case(case)

    @app.put("/api/cases/{case_id}/speakers")
    def put_speakers(case_id: str, body: dict):
        _case_path(case_id)
        if jobs.running(case_id, EDIT_BLOCKING):
            raise HTTPException(409, "처리 중에는 화자를 바꿀 수 없습니다.")
        return {"speakers": case_store.set_speakers(case_id, body.get("speakers", []))}

    # ---- 구간 단위 분석: 읽기 전용이다. 무거운 계산은 plain def라 스레드 풀에서 돈다 ----

    def _analysis_target(case_id: str, track: str, start: float | None, end: float | None):
        """(트랙 파일, 캐시 폴더, 트랙 길이, 시작, 끝). 시작·끝을 빼면 파일 전체."""
        d = _case_path(case_id)
        path = _resolve_track(case_id, d, track)
        duration = analysis.audio_info(path)["duration"]
        return (path, d / "work" / "analysis", duration, 0.0 if start is None else start,
                duration if end is None else end)

    @app.get("/api/cases/{case_id}/peaks")
    def get_peaks(case_id: str, track: str = "orig", start: float | None = None, end: float | None = None,
                  n: int = 2000):
        path, cache, duration, start, end = _analysis_target(case_id, track, start, end)
        return {**analysis.peaks(path, cache, start, end, n), "duration": duration}

    @app.get("/api/cases/{case_id}/spectrogram")
    def get_spectrogram(case_id: str, track: str = "orig", start: float | None = None, end: float | None = None,
                        cols: int = 1000):
        path, cache, duration, start, end = _analysis_target(case_id, track, start, end)
        return {**analysis.spectrogram(path, cache, start, end, cols), "duration": duration}

    @app.get("/api/cases/{case_id}/pitch")
    def get_pitch(case_id: str, track: str = "orig", start: float | None = None, end: float | None = None):
        path, _, duration, start, end = _analysis_target(case_id, track, start, end)
        return {**analysis.pitch(path, start, end), "duration": duration}

    @app.get("/api/cases/{case_id}/speech")
    def get_speech(case_id: str):
        path, cache, duration, _, _ = _analysis_target(case_id, "orig", None, None)
        return {"speech": analysis.speech_intervals(path, cache), "duration": duration}

    @app.get("/api/cases/{case_id}/analyze")
    def get_analyze(case_id: str, track: str = "orig", start: float | None = None, end: float | None = None):
        path, cache, duration, start, end = _analysis_target(case_id, track, start, end)
        speech = analysis.speech_intervals(path, cache)  # 그 트랙 자체의 말소리 구간
        # 응답의 duration은 고른 구간 길이라, 트랙 길이는 track_duration으로 따로 준다
        return {**analysis.analyze(path, start, end, speech), "track_duration": duration}

    @app.get("/api/cases/{case_id}/audio/clip")
    def get_clip(case_id: str, track: str = "orig", start: float | None = None, end: float | None = None,
                 boost: bool = False):
        path, _, _, start, end = _analysis_target(case_id, track, start, end)
        return Response(analysis.clip_wav(path, start, end, boost), media_type="audio/wav")

    @app.get("/api/cases/{case_id}/audio/listen")
    def listen(case_id: str):
        d = _case_path(case_id)
        return FileResponse(_resolve_track(case_id, d, "orig"), media_type="audio/wav")

    def _track_path(case_id: str, d: Path, speaker: str) -> Path:
        tracks = (case_store.load_case(case_id).get("processing") or {}).get("tracks", {})
        if speaker not in tracks or not (d / tracks[speaker]).exists():
            raise HTTPException(404, "분리 음성이 없습니다.")
        return d / tracks[speaker]

    def _resolve_track(case_id: str, d: Path, track: str) -> Path:
        """원본 길이의 보존 사본에서 현재 컷을 적용한 캐시를 돌려준다."""
        source = d / "work" / "listen.wav" if track == "orig" else _track_path(case_id, d, track)
        case = case_store.load_case(case_id)
        info = editing.summary(case)
        if not info["cuts"]:
            return source
        safe_track = re.sub(r"[^a-zA-Z0-9_-]", "_", track)
        target = d / "work" / "edited" / f"r{info['revision']}_{safe_track}.wav"
        return editing.render_file(source, target, info["cuts"])

    @app.get("/api/cases/{case_id}/audio/track/{speaker}")
    def track(case_id: str, speaker: str):
        d = _case_path(case_id)
        return FileResponse(_resolve_track(case_id, d, speaker), media_type="audio/wav")

    @app.post("/api/cases/{case_id}/similarity")
    def similarity(case_id: str, body: dict):
        """고른 구간이 등록된 사람 각각과 얼마나 닮았는지. 참고용이라 어디에도 저장하지 않는다."""
        d = _case_path(case_id)
        if jobs.running():
            raise HTTPException(409, "처리 중에는 닮음 점수를 볼 수 없습니다.")
        path = _resolve_track(case_id, d, str(body.get("track", "orig")))
        try:
            start, end = float(body["start"]), float(body["end"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("구간의 시작과 끝은 숫자여야 합니다.")
        start, end = analysis.check_window(analysis.audio_info(path)["duration"], start, end)
        speakers = case_store.public_speakers(case_store.load_case(case_id))[0]
        try:
            with pool.use() as enc:  # 계산이 끝나기 전에 모델이 내려가지 않게 붙잡는다
                return analysis.similarity(enc, _resolve_track(case_id, d, "orig"), speakers, path, start, end)
        except PoolBlocked:
            raise HTTPException(409, "처리 중에는 닮음 점수를 볼 수 없습니다.")

    @app.post("/api/cases/{case_id}/process", status_code=202)
    def process(case_id: str):
        _case_path(case_id)
        with pool.exclusive():  # 처리가 메모리를 쓰기 전에 화자 모델을 내리고, 시작할 때까지 새로 올리지 못하게 한다
            started = jobs.start(case_id)
        if not started:
            raise HTTPException(409, "다른 처리가 이미 진행 중입니다.")
        return jobs.current()

    @app.post("/api/cases/{case_id}/transcribe", status_code=202)
    def transcribe(case_id: str):
        _case_path(case_id)
        with pool.exclusive():
            started = jobs.start(case_id, "transcribe", transcribe_fn)
        if not started:
            raise HTTPException(409, "다른 처리가 이미 진행 중입니다.")
        return jobs.current()

    @app.get("/api/jobs/current")
    def job_current():
        return jobs.current()

    @app.get("/api/cases/{case_id}/transcript")
    def get_transcript(case_id: str):
        _case_path(case_id)
        return _public_transcript(case_id)

    @app.put("/api/cases/{case_id}/transcript")
    def put_transcript(case_id: str, body: dict):
        d = _case_path(case_id)
        if jobs.running(case_id, EDIT_BLOCKING):
            raise HTTPException(409, "처리 중에는 녹취록을 고칠 수 없습니다.")
        with case_store._lock:
            data = _read_transcript(d)
            if body.get("created_at", data["created_at"]) != data["created_at"]:
                raise HTTPException(409, "녹취록이 새로 만들어졌습니다. 화면을 다시 불러오세요.")
            case = case_store.load_case(case_id)
            source_duration = float(case["original"]["probe"]["duration"])
            cuts = editing.cuts_from_edits(editing.edit_state(case), source_duration)
            duration = editing.edited_duration(source_duration, cuts)
            editing.ensure_entry_sources(data["entries"], source_duration, cuts)
            speakers = {s["id"] for s in case["speakers"]} | {"unknown"}  # 화자 확인 필요 줄
            changes = {e.get("id"): e for e in body.get("entries", [])}
            known = {e["id"] for e in data["entries"]}
            for mid, c in changes.items():
                if mid in known or not isinstance(mid, str) or not MANUAL_ID.fullmatch(mid):
                    continue
                start = float(c.get("start", -1))
                if not 0 <= start <= duration + 0.05:
                    raise ValueError(f"{mid}: 녹음 길이 밖의 시각입니다.")
                end = min(duration, max(start, float(c.get("end", start))))
                data["entries"].append({"id": mid, "speaker": None, "start": round(start, 3),
                                        "end": round(end, 3),
                                        "source_ranges": editing.edited_range_to_source(start, end, source_duration, cuts), "text": "",
                                        "words": [], "low": [], "reviewed": False, "excluded": False,
                                        "exclude_reason": None, "source": "manual"})
            for e in data["entries"]:
                c = changes.get(e["id"])
                if c is None:
                    continue
                if c.get("speaker", e["speaker"]) not in speakers:
                    raise ValueError(f"{e['id']}: 없는 화자입니다.")
                e["speaker"] = c.get("speaker", e["speaker"])
                e["text"] = str(c.get("text", e["text"]))
                e["reviewed"] = bool(c.get("reviewed", e["reviewed"]))
                if e["reviewed"]:
                    e["cut_review_required"] = False
                if "excluded" in c:
                    e["excluded"] = bool(c["excluded"])
                    e["exclude_reason"] = c.get("exclude_reason") if e["excluded"] else None
                    if e["excluded"] and e["exclude_reason"] not in EXCLUDE_REASONS:
                        raise ValueError(f"{e['id']}: 줄을 뺀 이유를 고르세요.")
            data["entries"].sort(key=lambda x: (x["start"], x["end"]))
            path = d / "transcript.json"
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        return _counts(_public_transcript(case_id, data)["entries"])

    def _edit(case_id: str, body: dict, delta: int | None = None):
        d = _case_path(case_id)
        if jobs.running(case_id, EDIT_BLOCKING):
            raise HTTPException(409, "처리 중에는 오디오를 편집할 수 없습니다.")
        with case_store._lock:
            case = case_store.load_case(case_id)
            state = editing.edit_state(case)
            expected = body.get("revision")
            if expected is not None and int(expected) != state["revision"]:
                raise HTTPException(409, "다른 편집이 먼저 저장되었습니다. 화면을 다시 불러오세요.")
            duration = float(case["original"]["probe"]["duration"])
            old_cuts = editing.cuts_from_edits(state, duration)
            transcript = _read_transcript(d) if (d / "transcript.json").exists() else None
            if transcript is not None:
                editing.ensure_entry_sources(transcript["entries"], duration, old_cuts)
            if delta is None:
                try:
                    start, end = float(body["start"]), float(body["end"])
                except (KeyError, TypeError, ValueError):
                    raise ValueError("자를 구간의 시작과 끝이 필요합니다.")
                case["edits"] = editing.add_cut(state, start, end, duration, case_store.now_iso())
                event = "컷 편집"
            else:
                case["edits"] = editing.move_cursor(state, delta)
                event = "컷 되돌리기" if delta < 0 else "컷 다시 적용"
            new_cuts = editing.cuts_from_edits(case["edits"], duration)
            if transcript is not None:
                for entry in transcript["entries"]:
                    projected = editing.project_interval(entry.get("source_ranges", []), duration, new_cuts)
                    if projected["partial"]:
                        entry["cut_review_required"] = True
                path = d / "transcript.json"
                tmp = path.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(tmp, path)
            case["log"].append({"at": case_store.now_iso(), "event": event,
                                "revision": case["edits"]["revision"]})
            case_store.save_case(case_id, case)
        return {"edit": editing.summary(case)}

    @app.post("/api/cases/{case_id}/edits/cut")
    def cut(case_id: str, body: dict):
        return _edit(case_id, body)

    @app.post("/api/cases/{case_id}/edits/undo")
    def undo(case_id: str, body: dict):
        return _edit(case_id, body, -1)

    @app.post("/api/cases/{case_id}/edits/redo")
    def redo(case_id: str, body: dict):
        return _edit(case_id, body, 1)

    @app.get("/api/cases/{case_id}/integrity")
    def integrity(case_id: str):
        _case_path(case_id)
        return case_store.verify_original(case_id)

    @app.post("/api/cases/{case_id}/export")
    def do_export(case_id: str):
        d = _case_path(case_id)
        entries = _public_transcript(case_id)["entries"]
        files = {k: f"exports/{fn(case_id).name}" for k, fn in
                 (("docx", export.export_docx), ("txt", export.export_txt), ("log", export.export_log))}
        return {"files": files, "counts": _counts(entries)}  # 화면이 아닌 저장된 내용 기준

    @app.get("/api/cases/{case_id}/files/{name}")
    def download(case_id: str, name: str):
        d = _case_path(case_id)
        if name != case_store.safe_name(name, ""):
            raise HTTPException(404, "파일이 없습니다.")
        for sub in ("exports", "tracks"):
            p = d / sub / name
            if p.is_file():
                if sub == "tracks":
                    tracks = (case_store.load_case(case_id).get("processing") or {}).get("tracks", {})
                    sid = next((key for key, value in tracks.items() if Path(value).name == name), None)
                    if sid is not None:
                        return FileResponse(_resolve_track(case_id, d, sid), filename=name)
                return FileResponse(p, filename=name)
        raise HTTPException(404, "파일이 없습니다.")

    if STATIC.is_dir():
        app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app

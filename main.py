import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"


IMAGE_EXTS = {".jpg", ".jpeg", ".jfif", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico"}
VIDEO_EXTS = {".mp4", ".webm", ".ogg", ".mov", ".m4v"}
PPT_EXTS = {".ppt", ".pptx"}

mimetypes.add_type("image/jpeg", ".jfif")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/x-icon", ".ico")
mimetypes.add_type("video/webm", ".webm")


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_filename(name: str) -> str:
    name = name.strip().replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    if not name:
        return "file"
    return name[:180]


def media_type_from_path(p: Path) -> Optional[str]:
    ext = p.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def find_soffice() -> Optional[Path]:
    env = os.environ.get("SOFFICE_PATH", "").strip().strip('"')
    if env:
        p = Path(env)
        if p.exists():
            return p

    for name in ("soffice", "soffice.exe"):
        w = shutil.which(name)
        if w:
            return Path(w)

    candidates = [
        Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
        Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def convert_ppt_to_png(src_path: Path, slides_dir: Path) -> List[str]:
    soffice = find_soffice()
    if not soffice:
        raise RuntimeError(
            "LibreOffice (soffice) не найден. Установи LibreOffice или задай SOFFICE_PATH."
        )

    try:
        import fitz  # PyMuPDF
    except Exception:
        raise RuntimeError("Не найден PyMuPDF. Установи: pip install PyMuPDF")

    slides_dir.mkdir(parents=True, exist_ok=True)

    for p in slides_dir.glob("slide_*.png"):
        try:
            p.unlink()
        except Exception:
            pass

    outdir = slides_dir.parent
    pdf_path = outdir / f"{src_path.stem}.pdf"
    if pdf_path.exists():
        try:
            pdf_path.unlink()
        except Exception:
            pass

    cmd = [
        str(soffice),
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--norestore",
        "--invisible",
        "--convert-to",
        "pdf",
        "--outdir",
        str(outdir),
        str(src_path),
    ]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(
            "LibreOffice конвертация в PDF не удалась: "
            + (r.stderr.decode("utf-8", "ignore") or r.stdout.decode("utf-8", "ignore"))
        )

    if not pdf_path.exists():
        pdfs = sorted(outdir.glob("*.pdf"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        if not pdfs:
            raise RuntimeError("LibreOffice не создал PDF (0 файлов).")
        pdf_path = pdfs[0]

    scale_raw = os.environ.get("PPT_RENDER_SCALE", "").strip()
    try:
        scale = float(scale_raw) if scale_raw else 2.0
    except Exception:
        scale = 2.0
    if scale < 0.5:
        scale = 0.5
    if scale > 8.0:
        scale = 8.0

    slide_names: List[str] = []
    doc = fitz.open(str(pdf_path))
    try:
        for i in range(doc.page_count):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            dst_name = f"slide_{i + 1:03d}.png"
            dst = slides_dir / dst_name
            pix.save(str(dst))
            slide_names.append(dst_name)
    finally:
        try:
            doc.close()
        except Exception:
            pass

    if not slide_names:
        raise RuntimeError("Не удалось отрендерить PNG слайды (0 страниц).")

    return slide_names


@dataclass
class Peer:
    ws: WebSocket
    role: str  # "client" | "admin"


class Hub:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.playlist_path = data_dir / "playlist.json"
        self.state_path = data_dir / "state.json"

        self.peers: List[Peer] = []

        self.playlist: List[Dict[str, Any]] = load_json(self.playlist_path, [])
        state = load_json(self.state_path, {})
        self.playing: bool = bool(state.get("playing", False))
        self.play_id: str = str(state.get("playId", "")) if state.get("playId") else ""
        self.start_at_server_ms: Optional[int] = state.get("startAtServerMs", None)
        if not isinstance(self.start_at_server_ms, int):
            self.start_at_server_ms = None
        if self.playing and (not self.play_id or self.start_at_server_ms is None):
            self.playing = False
            self.play_id = ""
            self.start_at_server_ms = None
            self._persist()

    def _persist(self) -> None:
        save_json(self.playlist_path, self.playlist)
        save_json(
            self.state_path,
            {
                "playing": self.playing,
                "playId": self.play_id,
                "startAtServerMs": self.start_at_server_ms,
            },
        )

    def _peers_counts(self) -> Dict[str, int]:
        clients = sum(1 for p in self.peers if p.role == "client")
        admins = sum(1 for p in self.peers if p.role == "admin")
        return {"clients": clients, "admins": admins}

    def state_payload(self) -> Dict[str, Any]:
        return {
            "type": "state",
            "playing": self.playing,
            "playId": self.play_id,
            "startAtServerMs": self.start_at_server_ms,
            "playlist": self.playlist,
            "peers": self._peers_counts(),
            "serverNowMs": now_ms(),
        }

    async def broadcast_state(self) -> None:
        payload = self.state_payload()
        dead: List[Peer] = []
        for p in list(self.peers):
            try:
                await p.ws.send_text(json.dumps(payload, ensure_ascii=False))
            except Exception:
                dead.append(p)
        if dead:
            for d in dead:
                try:
                    self.peers.remove(d)
                except ValueError:
                    pass

    async def send_error(self, ws: WebSocket, message: str) -> None:
        try:
            await ws.send_text(json.dumps({"type": "error", "message": message}, ensure_ascii=False))
        except Exception:
            pass

    def set_playlist(self, playlist: List[Dict[str, Any]]) -> None:
        norm: List[Dict[str, Any]] = []
        for it in playlist or []:
            if not isinstance(it, dict):
                continue
            t = it.get("type")
            url = it.get("url")
            name = it.get("name") or ""
            if t not in ("image", "video"):
                continue
            if not isinstance(url, str) or not url.startswith("/media/"):
                continue

            item: Dict[str, Any] = {
                "id": str(it.get("id") or uuid.uuid4().hex),
                "type": t,
                "url": url,
                "name": str(name),
            }
            if t == "image":
                dm = it.get("durationMs")
                if not isinstance(dm, int):
                    dm = 5000
                dm = max(250, min(dm, 600_000))
                item["durationMs"] = dm
            norm.append(item)

        self.playlist = norm
        self._persist()

    def stop(self) -> None:
        self.playing = False
        self.play_id = ""
        self.start_at_server_ms = None
        self._persist()

    def play(self, start_delay_ms: int = 1500) -> Optional[str]:
        if not self.playlist:
            return None
        start_delay_ms = max(200, min(int(start_delay_ms), 10_000))
        self.playing = True
        self.play_id = uuid.uuid4().hex
        self.start_at_server_ms = now_ms() + start_delay_ms
        self._persist()
        return self.play_id


def build_app(media_dir: Path, data_dir: Path) -> FastAPI:
    app = FastAPI()
    hub = Hub(data_dir=data_dir)

    media_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    app.mount("/media", StaticFiles(directory=str(media_dir)), name="media")

    def read_template(name: str) -> str:
        p = TEMPLATES_DIR / name
        return p.read_text("utf-8")

    @app.get("/")
    async def root() -> RedirectResponse:
        return RedirectResponse(url="/client")

    @app.get("/client")
    async def client_page() -> HTMLResponse:
        return HTMLResponse(read_template("client.html"))

    @app.get("/admin")
    async def admin_page() -> HTMLResponse:
        return HTMLResponse(read_template("admin.html"))

    @app.get("/api/state")
    async def api_state() -> JSONResponse:
        return JSONResponse(hub.state_payload())

    @app.post("/api/upload")
    async def api_upload(file: UploadFile = File(...)) -> JSONResponse:
        original = safe_filename(file.filename or "file")
        ext = Path(original).suffix.lower()
        if not ext:
            return JSONResponse({"ok": False, "error": "Файл без расширения."}, status_code=400)

        if ext in PPT_EXTS:
            deck_id = uuid.uuid4().hex
            deck_dir = media_dir / "_decks" / deck_id
            slides_dir = deck_dir / "slides"
            deck_dir.mkdir(parents=True, exist_ok=True)

            src_path = deck_dir / f"source{ext}"
            size = 0
            try:
                with src_path.open("wb") as f:
                    while True:
                        chunk = await file.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        size += len(chunk)
            finally:
                try:
                    await file.close()
                except Exception:
                    pass

            try:
                slide_files = convert_ppt_to_png(src_path=src_path, slides_dir=slides_dir)
            except Exception as e:
                try:
                    if slides_dir.exists():
                        shutil.rmtree(slides_dir, ignore_errors=True)
                except Exception:
                    pass
                return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

            slides = [f"/media/_decks/{deck_id}/slides/{n}" for n in slide_files]
            meta = {
                "id": deck_id,
                "name": original,
                "createdMs": now_ms(),
                "count": len(slides),
                "slides": slides,
            }
            save_json(deck_dir / "meta.json", meta)

            return JSONResponse(
                {
                    "ok": True,
                    "item": {
                        "id": deck_id,
                        "type": "deck",
                        "url": slides[0],
                        "name": original,
                        "size": size,
                        "count": len(slides),
                        "slides": slides,
                    },
                }
            )

        t = media_type_from_path(Path("x" + ext))
        if t is None:
            return JSONResponse({"ok": False, "error": f"Неподдерживаемый тип: {ext}"}, status_code=400)

        uid = uuid.uuid4().hex
        stored_name = f"{uid}_{original}"
        dst = media_dir / stored_name

        size = 0
        try:
            with dst.open("wb") as f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    size += len(chunk)
        finally:
            try:
                await file.close()
            except Exception:
                pass

        url = f"/media/{stored_name}"
        return JSONResponse(
            {
                "ok": True,
                "item": {
                    "id": uid,
                    "type": t,
                    "url": url,
                    "name": original,
                    "size": size,
                    "mime": mimetypes.guess_type(original)[0] or "",
                },
            }
        )

    @app.get("/api/media")
    async def api_media_list() -> JSONResponse:
        items: List[Dict[str, Any]] = []

        decks_root = media_dir / "_decks"
        if decks_root.exists():
            for d in sorted(decks_root.glob("*")):
                if not d.is_dir():
                    continue
                meta_path = d / "meta.json"
                if not meta_path.exists():
                    continue
                meta = load_json(meta_path, {})
                slides = meta.get("slides", [])
                if not isinstance(slides, list) or not slides:
                    continue

                slides_dir = d / "slides"
                total = 0
                mtime = 0
                if slides_dir.exists():
                    for p in slides_dir.glob("*.png"):
                        try:
                            st = p.stat()
                            total += st.st_size
                            mtime = max(mtime, int(st.st_mtime * 1000))
                        except Exception:
                            pass

                items.append(
                    {
                        "id": str(meta.get("id") or d.name),
                        "type": "deck",
                        "url": str(slides[0]),
                        "name": str(meta.get("name") or d.name),
                        "size": total,
                        "mtimeMs": mtime or int(time.time() * 1000),
                        "count": int(meta.get("count") or len(slides)),
                        "slides": slides,
                    }
                )

        for p in sorted(media_dir.rglob("*")):
            if not p.is_file():
                continue
            try:
                rel = p.relative_to(media_dir)
            except Exception:
                continue
            if rel.parts and rel.parts[0] == "_decks":
                continue

            t = media_type_from_path(p)
            if t is None:
                continue

            st = p.stat()
            rel_posix = rel.as_posix()
            items.append(
                {
                    "id": p.stem.split("_", 1)[0] if "_" in p.stem else p.stem,
                    "type": t,
                    "url": f"/media/{rel_posix}",
                    "name": p.name.split("_", 1)[1] if "_" in p.name else p.name,
                    "size": st.st_size,
                    "mtimeMs": int(st.st_mtime * 1000),
                }
            )

        return JSONResponse({"ok": True, "items": items})

    @app.post("/api/playlist")
    async def api_set_playlist(payload: Dict[str, Any]) -> JSONResponse:
        playlist = payload.get("playlist", [])
        if not isinstance(playlist, list):
            return JSONResponse({"ok": False, "error": "playlist должен быть массивом."}, status_code=400)
        hub.set_playlist(playlist)
        await hub.broadcast_state()
        return JSONResponse({"ok": True})

    @app.get("/api/playlist")
    async def api_get_playlist() -> JSONResponse:
        return JSONResponse({"ok": True, "playlist": hub.playlist})

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        peer = Peer(ws=ws, role="client")
        hub.peers.append(peer)
        await ws.send_text(json.dumps(hub.state_payload(), ensure_ascii=False))
        await hub.broadcast_state()

        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue

                mtype = msg.get("type")

                if mtype == "hello":
                    role_ = msg.get("role")
                    if role_ in ("client", "admin"):
                        peer.role = role_
                        await hub.broadcast_state()

                elif mtype == "ping":
                    t0 = msg.get("t0")
                    if isinstance(t0, (int, float)):
                        await ws.send_text(
                            json.dumps(
                                {"type": "pong", "t0": t0, "serverMs": now_ms()},
                                ensure_ascii=False,
                            )
                        )

                elif mtype == "set_playlist":
                    if peer.role != "admin":
                        continue
                    playlist = msg.get("playlist", [])
                    if not isinstance(playlist, list):
                        await hub.send_error(ws, "playlist должен быть массивом.")
                        continue
                    hub.set_playlist(playlist)
                    await hub.broadcast_state()

                elif mtype == "play":
                    if peer.role != "admin":
                        continue
                    start_delay_ms = msg.get("startDelayMs", 1500)
                    try:
                        start_delay_ms = int(start_delay_ms)
                    except Exception:
                        start_delay_ms = 1500

                    play_id = hub.play(start_delay_ms=start_delay_ms)
                    if play_id is None:
                        await hub.send_error(ws, "Плейлист пустой.")
                        continue
                    await hub.broadcast_state()

                elif mtype == "stop":
                    if peer.role != "admin":
                        continue
                    hub.stop()
                    await hub.broadcast_state()

                elif mtype == "hint_fullscreen":
                    if peer.role != "admin":
                        continue
                    payload = {"type": "hint_fullscreen"}
                    dead: List[Peer] = []
                    for p in list(hub.peers):
                        if p.role != "client":
                            continue
                        try:
                            await p.ws.send_text(json.dumps(payload, ensure_ascii=False))
                        except Exception:
                            dead.append(p)
                    if dead:
                        for d in dead:
                            try:
                                hub.peers.remove(d)
                            except ValueError:
                                pass
                        await hub.broadcast_state()

                elif mtype == "clear_overlay":
                    if peer.role != "admin":
                        continue
                    payload = {"type": "clear_overlay"}
                    dead: List[Peer] = []
                    for p in list(hub.peers):
                        if p.role != "client":
                            continue
                        try:
                            await p.ws.send_text(json.dumps(payload, ensure_ascii=False))
                        except Exception:
                            dead.append(p)
                    if dead:
                        for d in dead:
                            try:
                                hub.peers.remove(d)
                            except ValueError:
                                pass
                        await hub.broadcast_state()

        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            try:
                hub.peers.remove(peer)
            except ValueError:
                pass
            await hub.broadcast_state()

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="LAN Sync Media Player (admin+clients in browser)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--media-dir", default=str(BASE_DIR / "media"))
    parser.add_argument("--data-dir", default=str(BASE_DIR / "data"))
    args = parser.parse_args()

    media_dir = Path(args.media_dir)
    data_dir = Path(args.data_dir)
    app = build_app(media_dir=media_dir, data_dir=data_dir)

    import uvicorn  # noqa: PLC0415

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
"""python -m truth_sound: 로컬 서버를 열고 브라우저를 띄운다."""
import socket
import threading
import time
import webbrowser

from . import config

HOST, PORT = "127.0.0.1", 8765
URL = f"http://{HOST}:{PORT}/"


def _port_in_use() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((HOST, PORT)) == 0


def main() -> None:
    if _port_in_use():  # 이미 켜져 있으면 창만 다시 연다
        print(f"Truth Sound가 이미 실행 중입니다: {URL}")
        webbrowser.open(URL)
        return
    config.setup_env()
    import uvicorn
    from .server import create_app

    server = uvicorn.Server(uvicorn.Config(create_app(), host=HOST, port=PORT, log_level="warning"))

    def _open_when_ready():
        while not server.started:
            time.sleep(0.2)
        print(f"Truth Sound 실행 중: {URL}  (끝내려면 이 창을 닫으세요)")
        webbrowser.open(URL)

    threading.Thread(target=_open_when_ready, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()

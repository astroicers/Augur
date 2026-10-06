"""在同一個 process 裡載入 ../server.py（不啟動 HTTP），讓評估腳本走伺服器真正的程式路徑。"""

import importlib.util
from pathlib import Path


def load_server():
    path = Path(__file__).resolve().parent.parent / "server.py"
    spec = importlib.util.spec_from_file_location("augur_tts_server", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # 會載模型、算參考音特徵（約 20 秒）
    return mod

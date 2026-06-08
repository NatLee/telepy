"""
統一的日誌設定：以 loguru 為輸出後端，並透過 InterceptHandler 把 Python 標準
logging 的所有紀錄轉送到 loguru。

Unified logging: loguru is the output backend, and InterceptHandler forwards every
stdlib `logging` record into loguru. The stdlib root logger owns a single
InterceptHandler, so EVERY logger (Django / DRF / Daphne / Channels / app modules
using `logging.getLogger(__name__)`) is captured in one place.

Sinks (configured by `configure_logging`):
- stdout         : 主控台 / console (for `docker logs`)
- telepy.log     : 所有等級、依時間排序 / all levels, chronological
- error.log      : 僅 WARNING 以上、供快速排查 / WARNING+ only, for triage
"""

import inspect
import logging
import sys

from loguru import logger


class InterceptHandler(logging.Handler):
    """把標準 logging 的紀錄轉送到 loguru / Forward stdlib logging records to loguru."""

    def emit(self, record: logging.LogRecord) -> None:
        # 將標準 logging 等級對應到 loguru 等級名稱，找不到就退回數字等級
        # Map the stdlib level to a loguru level name; fall back to the numeric level.
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # 從本 emit() 開始往上走出 logging 內部框架，讓 loguru 記錄到真正的呼叫位置。
        # 這是 loguru 官方建議的寫法：以 inspect.currentframe() 為起點、depth 從 0 開始，
        # 逐格累加，depth 才會與實際框架距離一致（frame 為 None 時自動停止）。
        # Canonical loguru pattern: start at this emit frame (depth 0) and step up while
        # still inside the stdlib logging machinery, so `depth` stays in sync with loguru's
        # own counting and points at the true caller (module:function:line).
        frame, depth = inspect.currentframe(), 0
        while frame is not None and (depth == 0 or frame.f_code.co_filename == logging.__file__):
            frame = frame.f_back
            depth += 1

        # 一併傳遞 exc_info，logger.exception(...) / exc_info=True 的完整 traceback 才會輸出
        # Forward exc_info so tracebacks from logger.exception(...) render in the files.
        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def configure_logging(
    log_root,
    retention: str = "14 days",
    rotation: str = "00:00",
    *,
    debug: bool = False,
) -> None:
    """
    （重新）安裝 loguru 的 sink：console + telepy.log + error.log。
    (Re)install loguru sinks. Idempotent — safe to call multiple times (runserver
    autoreload re-imports settings, test runner re-imports, etc.) because it removes
    all existing sinks first.

    等級過濾交給「標準 logging」這一層（root 的 LOG_LEVEL 與各 logger 覆寫）決定；
    loguru 的 console / telepy.log sink 一律敞開到 DEBUG，避免「兩層過濾」把已經被
    standard logging 放行的紀錄又擋掉（例如 prod 下 custom_auth=DEBUG 的除錯訊息）。
    Level filtering is owned by the STDLIB logging layer (root LOG_LEVEL + per-logger
    overrides). The console / telepy.log sinks stay wide open at DEBUG so a second
    filter never drops records that stdlib already allowed (e.g. custom_auth=DEBUG
    breadcrumbs in production where the global level is INFO).

    Args:
        log_root: 日誌目錄 / directory to write log files into (pathlib.Path-like).
        retention: 保留期間 / how long to keep rotated files (loguru syntax, e.g. "14 days").
        rotation:  輪替時機 / when to rotate (e.g. "00:00" for daily at midnight).
        debug:     是否展開 traceback 變數值 / whether to expand traceback variable values.
                   注意：diagnose=True 會把區域變數值（含 token/密碼）寫進日誌，正式環境務必關閉。
                   NOTE: diagnose=True writes local variable VALUES (incl. tokens/passwords)
                   into logs — must stay off in production.
    """
    # 先移除所有既有 sink（含 loguru 預設的 stderr），確保重複呼叫不會產生重複輸出
    # Remove all existing sinks (incl. loguru's default stderr) so repeated calls
    # never produce duplicate output.
    logger.remove()

    fmt = (
        "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | "
        "{name}:{function}:{line} - {message}"
    )

    file_opts = dict(
        format=fmt,
        rotation=rotation,
        retention=retention,
        compression="gz",
        encoding="utf-8",
        enqueue=True,        # 執行緒/async 安全（Channels）/ thread- & async-safe (Channels)
        backtrace=debug,
        diagnose=debug,
    )

    # 主控台 / console（敞開到 DEBUG，實際過濾由 stdlib logger 等級決定）
    logger.add(
        sys.stdout,
        level="DEBUG",
        format=fmt,
        enqueue=True,
        backtrace=debug,
        diagnose=debug,
    )

    # 統一日誌：stdlib 放行的所有等級 / unified file: every level stdlib lets through
    logger.add(str(log_root / "telepy.log"), level="DEBUG", **file_opts)

    # 錯誤日誌：僅 WARNING 以上 / error file: WARNING and above only
    logger.add(str(log_root / "error.log"), level="WARNING", **file_opts)

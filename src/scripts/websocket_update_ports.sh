#!/bin/bash

# ================================
# This is a script that will update the ports of the backend server
# ================================
#
# 以「常駐」模式執行 update_ports：Django 只 import 一次，迴圈與 sleep 都在 Python 內處理。
# 舊做法是這裡用 shell while 每 5s 呼叫一次 `python manage.py update_ports`，每次都重新 import
# 整個 Django/DRF/channels，週期性吃滿 CPU 並拖慢同容器的 gunicorn worker。改為 --loop 後消除此尖峰。
# Run update_ports as a resident process (--loop): Django is imported once and the loop/sleep live in
# Python, eliminating the per-cycle cold-start CPU spike that previously janked the workers.

cd /src

exec python manage.py update_ports --loop --interval 5

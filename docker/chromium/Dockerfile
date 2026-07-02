# Shared headless Chromium for the CDP screencast proxy-browser.
#
# Base = chromedp/headless-shell (just "Chrome + a CDP endpoint", no supervisord, no
# proxy env-hacks). We only add CJK fonts so Chinese/Japanese/Korean pages render as
# glyphs instead of tofu boxes. Chinese *input* (IME) is handled in the frontend, not here.
#
# Only needed if you see tofu on CJK sites; otherwise docker-compose.yml can use
# chromedp/headless-shell:latest directly. Build via:  docker compose build chromium
FROM chromedp/headless-shell:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

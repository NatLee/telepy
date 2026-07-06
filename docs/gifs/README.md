# Demo GIFs

The main `README.md` references three GIFs in this folder. Record them at these exact filenames:

| File                 | Suggested flow                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `create-tunnel.gif`  | Tunnels dashboard → **Create Tunnel** → paste key + name → wizard steps (keys / users / test connection) → dashboard shows the new tunnel **Online** |
| `web-terminal.gif`   | Dashboard → **Terminal** on an online tunnel → shell connects → run `uname -a`, `uptime`                                 |
| `remote-browser.gif` | Terminal page → **Browser** view → **Start Browser** → Chromium desktop loads a page through the tunnel                  |

## Recording tips

- Window size ~1280×800, light theme, English UI (matches the README).
- Keep each clip focused: 10–25 seconds.
- Avoid showing real hostnames/keys you care about; a scratch VM or container makes a good demo target.

## Compression

Keep each GIF under ~2 MB so the README loads fast. With [gifsicle](https://www.lcdf.org/gifsicle/):

```bash
gifsicle -O3 --lossy=80 --colors 128 --resize-width 1100 input.gif -o output.gif
```

Or convert a screen recording (`.mov`/`.mp4`) straight to an optimized GIF with ffmpeg + gifsicle:

```bash
ffmpeg -i recording.mov -vf "fps=8,scale=1100:-1:flags=lanczos" -f gif - \
  | gifsicle -O3 --lossy=80 --colors 128 -o create-tunnel.gif
```

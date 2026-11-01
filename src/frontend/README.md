# Telepy frontend

The web interface of Telepy, built with Next.js, TypeScript and Tailwind CSS.

You usually don't run it on its own. `docker compose up` at the top of the repository builds it and serves it behind Traefik. Run it here when you are working on the interface.

## Run it locally

You need Node.js 22.18 or newer and a running Telepy backend. The Docker stack is fine for that.

```bash
npm ci
npm run dev
```

Then open http://localhost:3000.

- API calls are passed through to the backend on `localhost:8787`. Set `NEXT_DEV_BACKEND_URL` if yours lives somewhere else.
- WebSockets can't go through that pass-through, so in development they connect to the backend directly.
- `npm run dev` first copies a few values from the repository's `.env`, such as the Google client ID and the backend address. `npm run env:sync` does only that step.

## Checks

```bash
npm test         # unit tests for the pure helpers
npm run lint
npm run build    # production build, type check included
```

## Good to know

- Every piece of text on screen is translated into English, Traditional Chinese and Japanese. Add the English text first. If the other two languages are missing a key, the build fails, which is annoying exactly once per string.
- In Traditional Chinese a tunnel is always 通道. A test checks this.
- If a style change seems to be ignored while the dev server runs, delete the `.next` folder. The dev server sometimes keeps serving an older compiled theme.

# Project structure and development notes

Orientation for working in the codebase.

## Project structure

```
.
├── server.ts                  # Backend entry point
├── index.html                 # Kiosk display (Vite entry)
├── settings-window.html       # Settings UI (Vite entry)
├── vite.config.ts             # Multi-page build + dev proxy + React Compiler
├── main/                      # Backend
│   ├── services/              # stage-controller, remote-server, pco-service,
│   │                          #   live-poller, propresenter-service, prodcom-service,
│   │                          #   wireless/device managers, integration-manager,
│   │                          #   stores (settings/slots/views/presets/layout-templates),
│   │                          #   slot-resolver, encryption, broadcaster, app-paths, …
│   ├── providers/wireless/    # Shure (ULX-D/Axient/PSM) + Sennheiser (EW-DX/EW-G4/Spectera) drivers + registry
│   └── types/                 # Backend type contracts (stage.ts: View/Output/LayoutDTO…)
├── renderer/                  # Frontend (React)
│   ├── main/                  # Displays: stage-view (router/picker) → slot grid,
│   │                          #   dashboard-view, stage-display-view, transcription-view,
│   │                          #   layout-renderer (custom layouts); hooks + pco-timer
│   ├── settings/              # Section components rendered by app/ routes
│   │                          #   (outputs-section, view-detail, slots-section,
│   │                          #   layout-editor, …)
│   ├── components/            # Shared components + ui/ primitives
│   ├── fonts/                 # Self-hosted Outfit (brand title)
│   └── lib/api.ts             # REST + SSE client
├── public/control.html        # Standalone phone remote
├── scripts/                   # install.sh / uninstall.sh
└── INSTALL.md                 # Server deployment guide
```

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server (frontend) on `:3000` |
| `npm run server` | Backend via `tsx server.ts` on `:8788` (dev) |
| `npm start` | Backend via `node --import tsx server.ts` (production) |
| `npm run build` | Build the renderer into `build/renderer/` |
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config + react-hooks) |
| `npm run format` | Format with `oxfmt` |

## Development notes

- **React Compiler** is enabled in `vite.config.ts` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` — components are auto-memoized at build time. (Vite 8 /
  Rolldown is oxc-based, so `@vitejs/plugin-react`'s `babel` option doesn't apply;
  the Rolldown Babel plugin is used instead.)
- The backend is run directly as TypeScript via `tsx`; there is no separate compile
  step. `tsx` is a runtime dependency for this reason.
- **Multiple displays in dev:** the Vite proxy mishandles several concurrent SSE
  streams, so only the most-recently-loaded display updates. Test multi-display
  against the built app on `:8788`, not the `:3000` dev server.
- **`localhost:3000` won't load?** Plain `vite` binds IPv6-only; if your browser
  resolves `localhost` to IPv4 it can't connect. Use `http://127.0.0.1:3000`
  (or run `npm run dev -- --host`), or just use the built app on `:8788`.
- **`PP_DEBUG=1`** before `npm run server` logs the ProPresenter slide→section
  resolution each poll (`rawIdx → section / next / text`) — handy when verifying the
  stage view against a live service.
- `npm run type-check`, `npm run lint`, and `npm run build` are all expected to pass
  cleanly before merging.

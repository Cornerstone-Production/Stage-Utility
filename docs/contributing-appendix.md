# Project structure and development notes

Orientation for working in the codebase.

## Project structure

```
.
├── server.ts                  # Backend entry point
├── index.html                 # Kiosk display bundle (Vite entry)
├── app.html                   # Operator app bundle (Vite entry)
├── vite.config.ts             # Multi-page build + dev proxy + React Compiler
├── main/                      # Backend
│   ├── services/              # stage-controller, remote-server, pco-service,
│   │   │                      #   live-poller, one <id>-service.ts per integration,
│   │   │                      #   integration-manager, the automation engine,
│   │   │                      #   the recorders, the stores, encryption, broadcaster
│   │   ├── routes/            # One module per slice of the HTTP surface
│   │   ├── archive/           # Raw-sample CSVs: write, read, export, import
│   │   └── update/            # Track detection, install kind, per-kind strategies
│   ├── providers/wireless/    # Shure (ULX-D/Axient/PSM/SBC) + Sennheiser
│   │                          #   (ewG4/EW-DX/Spectera) drivers + registry
│   └── types/                 # Backend type contracts (views.ts: View/Output/LayoutDTO…)
├── renderer/                  # Frontend (React)
│   ├── app/                   # The operator app: router, rail, context bar,
│   │                          #   destinations, Home, Screens
│   ├── main/                  # Displays: stage-view → slot grid, dashboard-view,
│   │                          #   stage-display-view, transcription-view,
│   │                          #   layout-renderer (custom layouts); hooks + pco-timer
│   ├── editor/                # The layout editor: canvas, palette, inspector
│   ├── settings/sections/     # Settings and tool pages rendered by app/ routes
│   ├── components/            # Shared components + ui/ primitives
│   └── lib/api.ts             # REST + SSE client
├── public/                    # App icon, web manifest, and a fallback remote page
├── packaging/homebrew/        # The Homebrew formula
├── scripts/                   # Install and update scripts, the kiosk agent
│                              #   installers, release tooling, hardware probes
└── INSTALL.md                 # Server deployment guide
```

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server (frontend) on `:3000` |
| `npm run server` | Backend via `tsx server.ts` on `:8788` (dev) |
| `npm start` | Backend via `node --import tsx server.ts` (production) |
| `npm run build` | Build both bundles into `build/renderer/` |
| `npm test` | The whole suite, on Node's test runner |
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

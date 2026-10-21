# ServiceCue on the web: the Worker

The public side of ServiceCue: a Cloudflare Worker that receives what a Stage Utility
server publishes and serves it, with the built ServiceCue page, to anyone with the link.
Nothing here knows who deploys it: no account id, no address, no church.

- **Set it up, what it costs, who can see it:** [ServiceCue on the web](../../docs/ops/servicecue-on-the-web.md).
- **The protocol:** [ServiceCue publishing protocol](../../docs/reference/servicecue-publishing.md),
  defined in [`main/types/servicecue-publish.ts`](../../main/types/servicecue-publish.ts),
  which the Worker, the page and the publisher all import.

## What is where

| | |
|---|---|
| `wrangler.jsonc` | the Worker's configuration: the built page as static assets (the build's own files answered without the Worker), the one Durable Object |
| `src/worker.ts` | the entry: hands each request to `handle` with the object, the static assets and the secret |
| `src/handle.ts` | everything the Worker does with a request but store it: routing, the token, body limits, validation, headers, every refusal |
| `src/routes.ts`, `auth.ts`, `body.ts`, `validate.ts`, `headers.ts`, `build.ts`, `messages.ts`, `capacity.ts` | the parts of that, as plain functions with no Workers API in them |
| `src/hub.ts` | the Durable Object: SQLite storage, and the viewers' sockets through the WebSocket Hibernation API |
| `src/hub-api.ts` | what the handler needs from the object, so it can be run against an in-memory one |
| `test/` | the Worker whole, in workerd |
| `public/` | the built page. Gitignored: `npm run servicecue:build` at the repository root writes it |

## Working on it

```bash
npm ci --include=dev                     # repository root: builds the page
npm --prefix publish/servicecue ci       # wrangler and the Workers types

npm run servicecue:dev                   # builds the page, runs the Worker on :8787
npm --prefix publish/servicecue run typecheck
npm --prefix publish/servicecue test     # the Worker in workerd, over HTTP and real sockets
npm test                                 # at the root: runs src/**/*.test.ts too
```

`servicecue:dev` needs a `.dev.vars` here holding `PUBLISH_TOKEN=` and 32 or more
characters; it is ignored by git.

The root `npm test` and `tsc` cover every file that does not import a Workers API,
the whole handler against an in-memory hub included. `worker.ts`, `hub.ts` and `env.ts`
import `cloudflare:workers` and are checked by this package's own `typecheck`. What only
workerd does (the object's storage, its sockets, the closes it accepts, the static asset
service) is shown by `npm test` here, which starts `wrangler dev` on a free local port
with its own empty storage and a made-up token. Nothing is sent to Cloudflare. CI runs
the type-check, the audit and that test in the `worker` job.

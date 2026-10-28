# Code scanning decisions

How this repository answers two CodeQL rules that flag the product's purpose, and
what stands behind each answer in the code.

## The two rules

`js/file-access-to-http` flags data read from a file that reaches a network
request. `js/http-to-file-access` flags data from the network that reaches a file
write. Neither has a sanitizer or barrier hook: no annotation, model or check in
the code tells the query that a value is safe, so the query flags every such flow
whatever stands between the read and the request.

In this app both flows are the point:

- An operator saves a credential (an API key, a client secret, a bearer token, a
  host and port) in Settings. It is read from disk and sent to the vendor it was
  issued for.
- A vendor answers with a file (a PDF attachment, an avatar). It is cached on disk
  so the next display does not download it again.

## Policy

Both rules stay on, so a new flow of either kind is flagged and reviewed.

The alerts for the flows listed below are dismissed once each, with a link to the
matching section here. Anything else the rules find is not covered by this page:
fix it, or add it here with the reason it is safe.

## Credentialed requests

A stored credential reaches the network only through one fetch function per
vendor origin. Each takes a branded URL type (a string a caller cannot write
by hand: a plain string does not compile) and re-pins the URL onto the origin
before the request is made. The pin writes the URL's path and query onto the
origin's own URL by assignment, never `new URL(path, origin)`, because that
constructor reads a path beginning `//` as a new host.

A request whose URL the pin has to move (which only a bug in the code that built
the URL can cause) is logged on the integration's tagged line, by origin only,
and the pinned URL is the one sent.

`main/services/pinned-fetch.test.ts` holds the guards. The brand is checked by
`tsc`, each helper is run against a forged URL, and a parse of the credentialed files with
the TypeScript compiler API asserts the exact list of `fetch` call sites in them.

| Integration | Fetch function | Pinned to |
|---|---|---|
| Planning Center | `pcoFetch` in `main/services/pco-service.ts` | `https://api.planningcenteronline.com` |
| SenSource token exchange | `senSourceAuthFetch` in `main/services/sensource-service.ts` | `https://auth.sensourceinc.com` |
| SenSource Vea API | `veaFetch` in `main/services/sensource-service.ts` | `https://vea.sensourceinc.com` |
| SafeSpace | `safeSpaceFetch` in `main/services/safespace-client.ts` | `https://app.safespace.io` |
| ProVideoPlayer | `pvpFetch` in `main/services/pvp-service.ts` | the operator's configured `scheme://host:port` |
| ServiceCue publishing | `publishFetch` in `main/services/servicecue-publish-client.ts` | the operator's configured page origin |
| ServiceCue page deploys | `cloudflareFetch` in `main/services/servicecue-cloudflare.ts` | `https://api.cloudflare.com` |

### Planning Center

`pcoFetch` takes a `PcoUrl`, made only by the `pcoUrl` tag (every path part has
been through `pcoId`, `pcoAttachmentId` or `pcoSegment`) or `pcoUrlOf`. It
carries the App ID and secret as a Basic authorization header. `pinnedToPco`
re-pins the URL and refuses one with a `..` segment. See
`main/services/pco-path.ts`.

### SenSource

Two origins, so two functions and two brands. `senSourceAuthFetch` takes a
`SenSourceAuthUrl` and carries the API client id and secret in the token request.
`veaFetch` takes a `SenSourceApiUrl` (`senSourceApiUrl(path)`, a path the code
writes) and carries the bearer token. The two brands are not interchangeable, so
neither credential can be sent to the other host.

### SafeSpace

`safeSpaceFetch` takes a `SafeSpaceUrl`, made only by `safeSpaceUrl(spaceId)`.
The space id is the whole credential and is URL-encoded into one path segment, so
it cannot add a segment, a query or a host. The log line for a moved URL names no
path, because the path is the credential.

### ProVideoPlayer

The ProVideoPlayer host is the operator's own, on their LAN, so the origin is not
a constant. `pvpOrigin` builds `scheme://host:port` from the configured host and
port and refuses a host that parses with a path, query, fragment or credentials
(`/`, `?`, `#`, `@` and `\` in a host name). `pvpFetch` takes that `PvpOrigin`
and a `PvpUrl` (`pvpUrl(origin, path)`) and re-pins the URL onto the origin, so a
path beginning `//` or holding `@` cannot move the bearer token to another host.

### ServiceCue publishing

The page the Public link card publishes to is the operator's own. `parsePublishUrl`
keeps only the origin of an `https://` address and returns a `PublishOrigin`; plain
`http://` is accepted for `localhost` and `127.0.0.1` only while
`STAGE_UTILITY_PUBLISH_ALLOW_LOCAL=1` is set on the server (development), so in
production the address cannot name the server's own machine or its ports. `publishFetch`
takes that origin and a `PublishUrl` (`publishUrl(origin, path)`) and re-pins the URL, so
the publishing token cannot leave for another host. It is also the only `fetch` in
the client, and it never follows a redirect.

`js/request-forgery` flags this request, because the address is typed by an operator.
Unlike the two rules above, it honours a barrier model, so the parse is declared as the
barrier: `.github/codeql/extensions/stage-utility-models/models/request-forgery-barriers.model.yml`
marks the result of `parsePublishUrl` (kind `request-forgery`), and an address that has not
been through it stays tainted. The fixture
`.github/codeql/tests/models/main/services/publish-forgery.ts` requests once from the raw
address, which must alert, and once from the parsed origin, which must not; removing the
model makes the second alert too. The alert is not dismissed and carries no suppression.

### ServiceCue page deploys

The server keeps the public page up to date through Cloudflare's API with an API token
the operator enters. `cloudflareFetch` takes a `CloudflareOrigin` (`cloudflareOrigin()`:
`https://api.cloudflare.com`, or plain `http` to a loopback address, which the server
accepts from the environment only while publishing to this machine is already allowed)
and a `CloudflareUrl` (`cloudflareUrl(origin, path)`), and re-pins the URL, so the token
cannot leave for another host. It is the only `fetch` in the file, it never follows a
redirect, and the file takes the token out of anything a failure says. The upload and
completion tokens Cloudflare hands back travel only to the same origin, through the same
function.

## Cached responses

A vendor response is written to disk in one place: `atomicWrite` in
`main/services/write-queue.ts`. It writes a uniquely named temp file beside the
destination and renames it into place, so a reader sees a whole file or none. It
writes where it is told; the path is the caller's. Two caches call it with
network data:

- **Planning Center attachments**, `main/services/pco-attachment-cache.ts`.
- **Planning Center photos**, `main/services/photo-cache.ts`. The URL must be on a
  Planning Center host (`isAllowedPhotoUrl`) before anything is fetched.

What keeps a network value from choosing the path:

- A photo file is named by the SHA-256 of the requested URL plus an extension of
  two to five word characters.
- An attachment file is named from the attachment id with every character outside
  `[a-zA-Z0-9_-]` removed, a version of `[a-z0-9]`, and an extension that is either
  one of five fixed words from the content type or two to five word characters
  from the file name.
- Both live in one directory under the data directory (`cache/photos`,
  `cache/attachments`), which the app creates. Neither name can hold `/` or `\`,
  and the only dots in one are the separators the code writes.

The attachment and photo downloads themselves carry no stored credential. The
attachment link is a signed, expiring URL that Planning Center issued for the
purpose, and the photo URL has no authorization header, so neither is one of the
credentialed fetches above.

# Live scores integration

Follows chosen teams' live scores from ESPN's public scoreboard and shows them in
the operator context bar, on Home, and on a stage display.

## Read this before you rely on it

**This uses an undocumented public API with no contract.** ESPN publishes no
terms for these endpoints, no versioning and no support channel. They can change
shape or disappear without notice, and the community reference for them warns
that excessive requests may be blocked — by source IP, which on a church network
is the whole building. That is why the app polls on a schedule rather than on a
fixed interval, and it is worth knowing before you put a score on a wall someone
is relying on.

A failure is surfaced rather than swallowed. A failed poll is reported on the
integration's card in Settings and carried in the data itself, so the expanded
card says "Last update failed" under the score. The last known scores are KEPT
rather than blanked — a display going empty reads as "no games", which is a
different and wrong statement from "we could not ask". With nothing to keep, the
surfaces say so in their own words rather than showing an empty box.

## What it needs

Nothing. No account, no key, no configuration beyond choosing teams — the
endpoints are public and unauthenticated.

## Choosing teams

**Settings → Integrations → Information → Live scores.** "Add a team" searches
every league at once by name or abbreviation; the leagues offered are MLB, NFL,
NBA and NHL.

A team is stored by ESPN's numeric id, not by name or abbreviation — both of
those move on a relocation or a rebrand, and the id survives it. The display name,
the abbreviation, the logo and the team colour are cached alongside it so a
display never fetches anything from ESPN's CDN itself, and they are refreshed
whenever the team list is read.

## Where it shows

| Surface | What it shows |
|---|---|
| Context bar | A capsule: two logos and two scores. Click it for the full card. |
| Live activity | The capsule expands in place into one card per followed game. |
| Custom layout | The **Live scores** object — one game, at wall size. |
| Home | The **Scores** card — a quieter reading for your own page. |

The context-bar item is opt-in: right-click the bar, **Configure bar…**, and drag
**Live scores** in. The panel expands under the bar and folds away on its own a
few seconds after a score; tapping the capsule, pressing anywhere else, or Escape
all close it, and any of those cancels the countdown so a dismissal is never
undone.

Wall displays get scores only if you place the layout object on one. The bar a
wall draws is fixed and has no capsule.

## Polling

One timer, and the cadence depends on what is actually happening:

| When | How often |
|---|---|
| A followed game is live and something is reading the channel | 25 s |
| A followed game is live and nothing is | 5 min |
| A followed game starts within the hour | 2 min |
| Nothing on today | 30 min |

Only leagues with a followed team are asked at all, and one league failing does
not blank the others. Broadcasts go out on change only, so a poll that found
nothing new is not an update to every display.

A consequence worth knowing: the game clock shown is ESPN's last reported value,
not a ticking one. It advances when a poll brings a new value, so during a live
game it steps about every 25 seconds rather than counting down second by second.
That is deliberate — a ticking clock would mean a broadcast per second per display
for a number nobody is timing anything against.

## Sports detail

Each sport's centre shows what answers "what is happening right now" for that
sport, not one shape wearing different labels: bases and the count for baseball,
down and distance and which team has the ball for football, the clock for
basketball and hockey. A sport the app has not specialised falls back to ESPN's
own status line, which is already written for that sport.

**One caveat worth stating.** Every football observation behind this was made
against college football, because no NFL game was in play on the day the endpoints
were surveyed. The NFL shares the sport path and the same situation keys, so this
is strong evidence rather than proof, and possession in particular is worth a
spot-check against a live NFL regular-season game.

The play-by-play sentence ESPN's own app shows ("… throws 80 mph slider outside
…") is **not** available: no endpoint returns it, ESPN composes it client-side,
and reconstructing it would be our prose presented as theirs. It is not shown.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/scores/status` | Followed games, scores and the last scoring change |
| GET | `/api/scores/favourites` | The followed teams |
| POST | `/api/scores/favourites` | Replace the followed teams |
| GET | `/api/scores/teams?league=<id>` | One league's teams, for the picker |

State is pushed on the `scores:status` SSE channel, and replayed to a client that
connects after the last change — a display opened mid-game shows the score it is
already at rather than sitting blank until somebody scores again.

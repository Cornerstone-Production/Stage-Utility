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

**Settings → Integrations → Information → Live scores.** "Add a team" asks for a
sport first, then lists that sport's teams with a search box over them, by name
or abbreviation. Eight leagues are offered:

| Professional | College |
|---|---|
| MLB, NFL, NBA, NHL | College football, men's and women's college basketball, college baseball |

The sport comes first because the college leagues are large — college football
alone is 760 clubs, and all eight together are about 2,000. One flat list of them
is not a list anybody can read, and the search narrows the chosen sport for the
same reason: "Chicago" across every league is seven teams in five sports.

Only the sport you open is fetched, and only when you open it.

A team is stored by ESPN's numeric id together with its league, not by name or
abbreviation — both of those move on a relocation or a rebrand, and the id
survives it. The league is part of the key because the id alone is not unique:
across these eight leagues, 267 ids name different clubs in different ones. The
display name, the abbreviation, the logo and the team colour are cached alongside
it so a display never fetches anything from ESPN's CDN itself, and they are
refreshed whenever the team list is read.

## Where it shows

| Surface | What it shows |
|---|---|
| Context bar | A capsule while a followed game is being played: two logos and two scores. Click it for the full card. **Nothing at all** the rest of the time. |
| Live activity | The capsule expands in place into one card per followed game, floating over the page. |
| Custom layout | The **Live scores** object — one game, at wall size. |
| Home | The **Scores** card — a quieter reading for your own page. |

The context-bar item is opt-in: right-click the bar, **Configure bar…**, and drag
**Live scores** in. The panel expands under the bar and folds away on its own a
few seconds after a score; tapping the capsule, pressing anywhere else, or Escape
all close it, and any of those cancels the countdown so a dismissal is never
undone.

It **floats over the page** rather than pushing it down. Nothing below the bar
moves when a score arrives, and the page underneath stays where you left it —
opening the panel on Screens used to slide the whole grid of cards down the
screen. Only the panel itself takes a press; the empty space beside it belongs to
the page, so a click there reaches what it looks like it will reach and closes
the panel on the way.

**The bar item is the one that disappears.** Every other reading on that strip
says something even at rest, and stays put so you can learn where to look. The
capsule does not: unless a followed game is actually in play it draws nothing and
takes no room, because for most of the year "no games" is a word that would never
change. The other three surfaces still say why they are empty — a wall widget
drawing nothing is indistinguishable from a broken one, and whoever placed it is
not in the room to check.

The layout object can be pinned to one followed team, and offers the teams you
follow with their league beside them.

Wall displays get scores only if you place the layout object on one. The bar a
wall draws is fixed and has no capsule.

## Polling

One timer, and the cadence depends on what is actually happening:

| When | How often |
|---|---|
| A followed game is live and something is reading the channel | 25 s |
| A followed game is live and nothing is | 5 min |
| A followed game starts within the hour, or is past its listed start and has not begun | 2 min |
| Nothing on today | 30 min |

Only leagues with a followed team are asked at all, and one league failing does
not blank the others. Broadcasts go out on change only, so a poll that found
nothing new is not an update to every display.

The listed start is when the two-minute tier ends, not when it stops mattering.
A game is marked as in play at the opening kickoff or the first pitch, which is
several minutes after the time on the schedule and can be hours after it through
a rain delay — so the two-minute tier is held past a listed start that has come
and gone, and the score appears within a couple of minutes of the game actually
starting rather than up to half an hour later.

**A game does not vanish at midnight.** ESPN files a game under the date it is
played on where it is played, so a Sunday night game listed 9:40pm stays on
Sunday's scoreboard while it is being played — including at ten past midnight.
While a followed game from the previous day is still in progress, that day is
asked for as well as the current one, and the board carries straight over. The
second request stops as soon as the game is over, and a night with nothing
running past midnight costs exactly one request per league per poll as before.
The log says so on the poll that starts carrying it.

That is what keeps the college leagues free: eight leagues on offer costs nothing
until one is followed, and each followed league adds one request per poll — so a
church following the Cubs never asks about college baseball.

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

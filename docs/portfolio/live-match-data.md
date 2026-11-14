# Live match data

I integrated the Sportmonks in-play API so the local dashboard could fetch scores, events, and statistics during a match. The feed turns the provider’s JSON into a CSV snapshot scoped to one league and season.

**Skills demonstrated** · Authenticated REST API calls · JSON validation and normalization · Polling and caching · Rate-limit handling

## My approach

- I pass the Sportmonks token in the `Authorization` header. The in-play request filters by league and asks for scores, participants, match state, periods, statistics, and events. I validate the response before filtering fixtures to the configured season and normalizing them into rows. [Authentication and response validation](../../src/fetch/live.py#L111) · [League filter and requested fields](../../src/fetch/live.py#L142)
- A shared in-memory cache limits provider requests when multiple callers refresh. The polling interval is 30 seconds during play and 60 seconds when the feed is idle. HTTP 429 responses use the provider’s `Retry-After` header with a minimum delay of 120 seconds.
- I fetch optional data such as lineups, expected goals, and pressure independently so a failed request for one feed still allows the base score and events to be displayed.
- When an observed fixture disappears from the in-play feed, I check it by fixture ID before recording it as finished. The snapshot includes an explicit availability status so the dashboard can distinguish a quiet matchday from an upstream failure.

## How I checked it

With mocked provider responses, I checked that consecutive callers received the same cached snapshot after one fetch. I also exercised the idle and unavailable states and verified that the snapshot carried the retry delay on an error.

## Read the code

- `fetch_fixtures()` validates the provider response and handles rate limits. [Provider request](../../src/fetch/live.py#L111)
- `snapshot()` coordinates the cache, lifecycle states, and CSV response. [Snapshot and polling](../../src/fetch/live.py#L418)
- `confirm_finished()` checks the state of fixtures that drop out of the in-play feed. [Full-time confirmation](../../src/fetch/live.py#L378)

# Agents

[CLAUDE.md](CLAUDE.md) holds this repository's rules for agents, and
[docs/contributing.md](docs/contributing.md) its conventions. Both apply to any
agent working here.

## Code Review Rules

- **A fix to a repeated pattern covers every instance.** When a change fixes or
  guards something that appears more than once (a timeout, a `.catch`, a buffer
  cap, a guard on one of several recorders or parsers), flag each copy the diff
  leaves unchanged. Fixing one of three is this repository's most expensive
  recurring mistake.
- **No failure is swallowed.** A new `catch` rethrows or returns the failure to
  its caller; one that only logs is a P1. A function that can partly fail
  returns what failed. A guard or test added for a bug must be one that fails on
  that bug: flag a check that reads source text a comment or declaration could
  satisfy, or that asserts a floor instead of an exact sorted list.
- **Nothing private reaches the public ServiceCue side.** For any change bound
  for `main`, trace what `publish/servicecue/` sends against the allowlist in
  [ServiceCue on the web](docs/ops/servicecue-on-the-web.md#who-can-see-it): no
  credentials, LAN addresses, device ids, contact details, log text or unneeded
  internal ids, whatever files the diff touches. A leak is a P0.

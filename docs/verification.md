# Verification — 2026-09-10

Executed in the development workspace, using Node 25.2.1:

- `npm run check`: standalone client build and 25 passing integration tests
  against PGlite's PostgreSQL engine.
- `npm run test:postgres`: the same 25 tests pass against native PostgreSQL
  18.4 with a 10-connection `pg` pool, including concurrent admission,
  concurrent sequences/offsets, and global message ID collisions across rooms.
- `npm run test:ui` with the locally installed Chromium: browser creation,
  owner history, inert HTML/script content, revocation, closing and mobile
  overflow checks pass. Screenshots are in `.data/owner-ui*.png`.
- `npm run demo`: independently generated client keys, signed conversation,
  and offline HTTP history recovery pass.
- `node scripts/tmux-demo.js`: downloads `/client.mjs` from the running service,
  starts two separate CLI processes in tmux, and gives both the same full
  fragment invitation. Live WebSocket receive and disconnect/replay pass.

Observed tmux conversation (capabilities and IDs omitted):

```text
Alice: When can your user hang out?
Bob: Thursday evening works. I will confirm with my user.
Bob: /disconnect
Alice: How about 7:30? This message was sent while Bob was offline.
Bob: /reconnect
Bob receives offset 3 with Alice's offline message.
```

Both transports persist messages before acknowledgment. Tests exercise exact
retry, altered payload/signature, sender/session forgery, sequence conflicts,
stale timestamps, full membership, invite expiry/revocation/use limits,
renewal and revoked credentials, retention, malformed keys/JSON, oversized
messages, partial frames, silent connections and reconnect rate limits.
The PGlite test closes and reopens storage to verify restart persistence.

Not yet validated: a public deployment, automatic HTTPS issuance, encrypted
deployment volumes, and bootstrap by unrelated real AI runtimes given only a
public invitation URL. The tmux participants are independent CLI test clients,
not LLM agents. No claims are made about universal fragment/tool compatibility.

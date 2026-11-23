# arcade-api

Hono + Node + MongoDB backend for the Battleship game. It is called only by the SvelteKit server (never the browser), so CORS is intentionally off.

## Setup

```sh
npm install
cp .env.example .env   # set MONGODB_URI
npm run dev
npm test               # uses an in-memory MongoDB, no setup needed
```

| Variable | Required | Default |
| --- | --- | --- |
| `MONGODB_URI` | yes | |
| `DB_NAME` | no | `arcade` |
| `PORT` | no | `3000` |
| `BCRYPT_ROUNDS` | no | `12` |
| `SESSION_TTL_DAYS` | no | `7` |

Game rules come from `@xiuxiuy/arcade-core` (`createRandomBoard`, `isValidShot`, `updateBoard`, `isGameComplete`). `package.json` points at `file:../arcade-core` for local work; before deploying, publish arcade-core 0.2.0 and depend on `^0.2.0`.

## Authentication

Sessions are opaque random tokens stored (SHA-256 hashed) in MongoDB with a TTL index. `signup` and `login` return a `token`; the SvelteKit server keeps it in an httpOnly cookie and sends it on every call as `Authorization: Bearer <token>`. Logout deletes the session, so the token stops working immediately.

## Errors

All errors are JSON: `{ "error": "message" }`. Validation failures add `details: [{ path, message }]`. Unhandled errors return 500 via `onError`.

## Endpoints

### Auth

| Method & path | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | `{ email, password (8–72), username? (3–20) }` | **201** `{ user, token }` | 400 invalid, 409 email taken |
| `POST /api/auth/login` | `{ email, password }` | **200** `{ user, token }` | 400 invalid, 401 wrong credentials |
| `POST /api/auth/logout` | | **200** `{ ok: true }` | 401 |
| `GET /api/auth/me` | | **200** `{ user }` | 401 |

`user` is `{ id, email, username }`. The password hash is never returned. `username` defaults to the email's local part.

### Games

All game endpoints need a token except viewing a finished game.

| Method & path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/games` | | **200** `{ waiting: [summary], mine: [summary] }` | 401 |
| `POST /api/games` | | **201** `{ game }`, caller is player 0 and the fleets are placed randomly | 401 |
| `GET /api/games/:id` | | **200** `{ game }` | 400 bad id, 401 not logged in and game unfinished, 403 not a player in an unfinished game, 404 |
| `POST /api/games/:id/players` | | **201** `{ game }`, game becomes `active` | 400, 401, 404, 409 own game / already joined / no longer waiting |
| `POST /api/games/:id/shots` | `{ x: 0–9, y: 0–9 }` | **201** `{ shot: { x, y, result: "hit"\|"miss", sunk: name\|null }, game }` | 400, 401, 403 not a player, 404, 409 not active / not your turn / repeat square / concurrent change |

`waiting` excludes games you created. `summary` is `{ id, status, players, you, yourTurn, winner, createdAt }` and contains no boards.

### Game shape

```jsonc
{
  "id": "…", "status": "waiting | active | complete",
  "players": [{ "id", "username" }, null],  // second is null until someone joins
  "you": 0,            // your seat, or null for a spectator of a finished game
  "turn": 0, "yourTurn": true,
  "winner": null,      // seat of the winner once complete
  "outcome": null,     // "won" | "lost" once complete, for players
  "yourBoard": { "size": 10, "ships": [{ "name", "size", "cells": [[x, y]] }], "shots": [{ "x", "y", "hit" }] },
  "opponentBoard": { "size": 10, "ships": [], "shots": [{ "x", "y", "hit" }] }
}
```

**Hidden information:** while a game is unfinished, `opponentBoard.ships` contains only ships that are already fully sunk. Every response is built by `projectGame` in `src/projection.js`. Once a game is complete both fleets are revealed, and spectators see it from seat 0's side (`you: null`).

### Other

`GET /api/health` returns **200** `{ ok: true }`.

## Data

- `users`: `{ email (unique index), username, passwordHash (bcrypt), createdAt }`
- `sessions`: `{ tokenHash (unique), userId, createdAt, expiresAt (TTL) }`
- `games`: `{ status, playerIds: [id, id|null], boards: [board, board], turn, winner, version, createdAt, updatedAt }`

`version` makes shots atomic: two simultaneous shots cannot both apply, and the loser gets 409.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { ensureIndexes } from '../src/db.js';

let mongod, client, db, app;

before(async () => {
	mongod = await MongoMemoryServer.create();
	client = await new MongoClient(mongod.getUri()).connect();
	db = client.db('test');
	await ensureIndexes(db);
	app = createApp({ db, bcryptRounds: 4 });
});

after(async () => {
	await client?.close();
	await mongod?.stop();
});

async function call(method, path, { token, body, raw } = {}) {
	const headers = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
	const res = await app.request(path, {
		method,
		headers,
		body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
	});
	return { status: res.status, body: await res.json() };
}

async function signup(name) {
	const res = await call('POST', '/api/auth/signup', {
		body: { email: `${name}@example.com`, password: 'password123', username: name }
	});
	assert.equal(res.status, 201);
	return res.body;
}

test('signup validates, hashes the password, and enforces unique email', async () => {
	assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'nope', password: 'x' } })).status, 400);
	assert.equal((await call('POST', '/api/auth/signup', { raw: '{bad json' })).status, 400);
	const { user, token } = await signup('alice');
	assert.equal(user.email, 'alice@example.com');
	assert.equal(user.passwordHash, undefined);
	assert.match(token, /^[a-f0-9]{64}$/);
	const stored = await db.collection('users').findOne({ email: 'alice@example.com' });
	assert.match(stored.passwordHash, /^\$2[aby]\$/);
	const dup = await call('POST', '/api/auth/signup', {
		body: { email: 'ALICE@example.com', password: 'password123' }
	});
	assert.equal(dup.status, 409);
});

test('login, me, logout invalidate the session', async () => {
	const bad = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'wrongwrong' } });
	assert.equal(bad.status, 401);
	assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'wrongwrong' } })).status, 401);
	const login = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'password123' } });
	assert.equal(login.status, 200);
	const { token } = login.body;
	const me = await call('GET', '/api/auth/me', { token });
	assert.equal(me.status, 200);
	assert.equal(me.body.user.username, 'alice');
	assert.equal(JSON.stringify(me.body).includes('passwordHash'), false);
	assert.equal((await call('GET', '/api/auth/me')).status, 401);
	assert.equal((await call('POST', '/api/auth/logout', { token })).status, 200);
	assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
});

test('full game: hidden fleet, turns, errors, win, public after over', async () => {
	const a = await signup('player1');
	const b = await signup('player2');
	const c = await signup('player3');

	assert.equal((await call('GET', '/api/games')).status, 401);
	assert.equal((await call('POST', '/api/games')).status, 401);

	const created = await call('POST', '/api/games', { token: a.token });
	assert.equal(created.status, 201);
	const id = created.body.game.id;
	assert.equal(created.body.game.status, 'waiting');
	assert.equal(created.body.game.yourBoard.ships.length, 5);
	assert.deepEqual(created.body.game.opponentBoard.ships, []);

	// listing
	const listB = await call('GET', '/api/games', { token: b.token });
	assert.equal(listB.status, 200);
	assert.ok(listB.body.waiting.some((g) => g.id === id));
	assert.equal(JSON.stringify(listB.body).includes('boards'), false);
	const listA = await call('GET', '/api/games', { token: a.token });
	assert.ok(!listA.body.waiting.some((g) => g.id === id));
	assert.ok(listA.body.mine.some((g) => g.id === id));

	// access control
	assert.equal((await call('GET', `/api/games/${id}`)).status, 401);
	assert.equal((await call('GET', `/api/games/${id}`, { token: b.token })).status, 403);
	assert.equal((await call('GET', '/api/games/not-an-id', { token: a.token })).status, 400);
	assert.equal((await call('GET', `/api/games/${new ObjectId()}`, { token: a.token })).status, 404);

	// join
	assert.equal((await call('POST', `/api/games/${id}/players`, { token: a.token })).status, 409);
	assert.equal((await call('POST', `/api/games/${new ObjectId()}/players`, { token: b.token })).status, 404);
	const fireEarly = await call('POST', `/api/games/${id}/shots`, { token: a.token, body: { x: 0, y: 0 } });
	assert.equal(fireEarly.status, 409);
	const joined = await call('POST', `/api/games/${id}/players`, { token: b.token });
	assert.equal(joined.status, 201);
	assert.equal(joined.body.game.status, 'active');
	assert.equal((await call('POST', `/api/games/${id}/players`, { token: c.token })).status, 409);

	// shot validation / permissions
	const shoot = (who, x, y) => call('POST', `/api/games/${id}/shots`, { token: who.token, body: { x, y } });
	assert.equal((await call('POST', `/api/games/${id}/shots`, { body: { x: 0, y: 0 } })).status, 401);
	assert.equal((await shoot(c, 0, 0)).status, 403);
	assert.equal((await call('POST', `/api/games/${id}/shots`, { token: a.token, body: { x: 10, y: 0 } })).status, 400);
	assert.equal((await call('POST', `/api/games/${id}/shots`, { token: a.token, body: { x: '1', y: 0 } })).status, 400);
	assert.equal((await shoot(b, 0, 0)).status, 409); // not b's turn

	// Peek at the real fleets to drive the game deterministically.
	const doc = await db.collection('games').findOne({ _id: new ObjectId(id) });
	const fleetA = new Set(doc.boards[0].ships.flatMap((s) => s.cells.map(([x, y]) => `${x},${y}`)));
	const fleetB = doc.boards[1].ships.flatMap((s) => s.cells);

	// a's view must not contain b's unsunk ships
	const viewA = await call('GET', `/api/games/${id}`, { token: a.token });
	assert.deepEqual(viewA.body.game.opponentBoard.ships, []);
	assert.equal(viewA.body.game.yourTurn, true);

	let sawSunk = false;
	let last;
	const bTargets = [];
	for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (!fleetA.has(`${x},${y}`)) bTargets.push([x, y]);
	for (let i = 0; i < fleetB.length; i++) {
		const [x, y] = fleetB[i];
		last = await shoot(a, x, y);
		assert.equal(last.status, 201);
		assert.equal(last.body.shot.result, 'hit');
		if (last.body.shot.sunk) {
			sawSunk = true;
			assert.ok(last.body.game.opponentBoard.ships.some((s) => s.name === last.body.shot.sunk));
		}
		if (i === 0) {
			assert.equal((await shoot(a, 0, 0)).status, 409); // a's turn is over
			const [mx, my] = bTargets[0];
			const miss = await shoot(b, mx, my);
			assert.equal(miss.status, 201);
			assert.equal(miss.body.shot.result, 'miss');
			assert.equal((await shoot(b, mx, my)).status, 409); // not b's turn now
			const again = await shoot(a, x, y);
			assert.equal(again.status, 409); // repeat square
			continue;
		}
		if (i < fleetB.length - 1) {
			const [mx, my] = bTargets[i];
			assert.equal((await shoot(b, mx, my)).status, 201);
		}
	}
	assert.ok(sawSunk);
	assert.equal(last.body.game.status, 'complete');
	assert.equal(last.body.game.outcome, 'won');
	assert.equal(last.body.game.winner, 0);

	// finished: no more shots, public to anyone, fully revealed
	assert.equal((await shoot(b, 9, 9)).status, 409);
	const pub = await call('GET', `/api/games/${id}`);
	assert.equal(pub.status, 200);
	assert.equal(pub.body.game.you, null);
	assert.equal(pub.body.game.opponentBoard.ships.length, 5);
	assert.equal(JSON.stringify(pub.body).includes('email'), false);
	const viewB = await call('GET', `/api/games/${id}`, { token: b.token });
	assert.equal(viewB.body.game.outcome, 'lost');
});

test('unknown routes and fallbacks return JSON', async () => {
	const res = await call('GET', '/api/nope');
	assert.equal(res.status, 404);
	assert.ok(res.body.error);
});

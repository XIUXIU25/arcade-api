import { Hono } from 'hono';
import { ObjectId } from 'mongodb';
import {
	createRandomBoard,
	getSunkShips,
	isGameComplete,
	isValidShot,
	updateBoard
} from '@xiuxiuy/arcade-core';
import { optionalAuth, requireAuth } from '../auth.js';
import { projectGame, summarizeGame, viewerIndex } from '../projection.js';
import { idParam, shotBody, validate } from '../validate.js';

export function gameRoutes({ db }) {
	const app = new Hono();
	const games = db.collection('games');
	const usersCol = db.collection('users');

	async function loadUsers(docs) {
		const ids = new Set();
		for (const game of docs) for (const id of game.playerIds) if (id) ids.add(id.toString());
		const found = await usersCol.find({ _id: { $in: [...ids].map((id) => new ObjectId(id)) } }).toArray();
		return new Map(found.map((user) => [user._id.toString(), user]));
	}

	app.get('/', requireAuth(db), async (c) => {
		const user = c.get('user');
		const [waiting, mine] = await Promise.all([
			games
				.find({ status: 'waiting', playerIds: { $ne: user._id } })
				.sort({ createdAt: -1 })
				.limit(50)
				.toArray(),
			games.find({ playerIds: user._id }).sort({ updatedAt: -1 }).limit(100).toArray()
		]);
		const users = await loadUsers([...waiting, ...mine]);
		return c.json(
			{
				waiting: waiting.map((game) => summarizeGame(game, user._id, users)),
				mine: mine.map((game) => summarizeGame(game, user._id, users))
			},
			200
		);
	});

	app.post('/', requireAuth(db), async (c) => {
		const user = c.get('user');
		const now = new Date();
		const game = {
			status: 'waiting',
			playerIds: [user._id, null],
			boards: [createRandomBoard(), createRandomBoard()],
			turn: 0,
			winner: null,
			version: 0,
			createdAt: now,
			updatedAt: now
		};
		const { insertedId } = await games.insertOne(game);
		const users = new Map([[user._id.toString(), user]]);
		return c.json({ game: projectGame({ ...game, _id: insertedId }, user._id, users) }, 201);
	});

	app.get('/:id', validate('param', idParam), optionalAuth(db), async (c) => {
		const game = await games.findOne({ _id: new ObjectId(c.req.valid('param').id) });
		if (!game) return c.json({ error: 'Game not found' }, 404);
		const user = c.get('user');

		if (game.status !== 'complete') {
			if (!user) return c.json({ error: 'Log in to view a game that is still in progress' }, 401);
			if (viewerIndex(game, user._id) === null) {
				return c.json({ error: 'You are not a player in this game' }, 403);
			}
		}
		const users = await loadUsers([game]);
		return c.json({ game: projectGame(game, user?._id ?? null, users) }, 200);
	});

	app.post('/:id/players', validate('param', idParam), requireAuth(db), async (c) => {
		const user = c.get('user');
		const id = new ObjectId(c.req.valid('param').id);
		const existing = await games.findOne({ _id: id });
		if (!existing) return c.json({ error: 'Game not found' }, 404);
		if (viewerIndex(existing, user._id) !== null) {
			return c.json({ error: 'You are already in this game' }, 409);
		}
		// Atomic: only one joiner can flip a waiting game to active.
		const now = new Date();
		const joined = await games.findOneAndUpdate(
			{ _id: id, status: 'waiting', 'playerIds.1': null },
			{ $set: { 'playerIds.1': user._id, status: 'active', updatedAt: now }, $inc: { version: 1 } },
			{ returnDocument: 'after' }
		);
		if (!joined) return c.json({ error: 'Game is no longer waiting for a player' }, 409);
		const users = await loadUsers([joined]);
		return c.json({ game: projectGame(joined, user._id, users) }, 201);
	});

	app.post(
		'/:id/shots',
		validate('param', idParam),
		requireAuth(db),
		validate('json', shotBody),
		async (c) => {
			const user = c.get('user');
			const { x, y } = c.req.valid('json');
			const game = await games.findOne({ _id: new ObjectId(c.req.valid('param').id) });
			if (!game) return c.json({ error: 'Game not found' }, 404);

			const you = viewerIndex(game, user._id);
			if (you === null) return c.json({ error: 'You are not a player in this game' }, 403);
			if (game.status === 'waiting') return c.json({ error: 'Waiting for a second player' }, 409);
			if (game.status === 'complete') return c.json({ error: 'Game is already over' }, 409);
			if (game.turn !== you) return c.json({ error: "It is not your turn" }, 409);

			const target = 1 - you;
			const before = game.boards[target];
			if (!isValidShot(before, x, y)) return c.json({ error: 'You already fired at that square' }, 409);

			const after = updateBoard(before, x, y);
			const hit = after.shots.at(-1).hit;
			const sunkBefore = new Set(getSunkShips(before).map((ship) => ship.name));
			const sunk = getSunkShips(after).find((ship) => !sunkBefore.has(ship.name))?.name ?? null;
			const over = isGameComplete(after);

			// Optimistic concurrency: a concurrent shot bumps `version` and this update matches nothing.
			const updated = await games.findOneAndUpdate(
				{ _id: game._id, version: game.version, status: 'active' },
				{
					$set: {
						[`boards.${target}`]: after,
						turn: over ? game.turn : target,
						status: over ? 'complete' : 'active',
						winner: over ? you : null,
						updatedAt: new Date()
					},
					$inc: { version: 1 }
				},
				{ returnDocument: 'after' }
			);
			if (!updated) return c.json({ error: 'Game changed while firing; reload and try again' }, 409);

			const users = await loadUsers([updated]);
			return c.json(
				{
					shot: { x, y, result: hit ? 'hit' : 'miss', sunk },
					game: projectGame(updated, user._id, users)
				},
				201
			);
		}
	);

	return app;
}

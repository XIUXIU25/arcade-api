import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { createSession, destroySession, publicUser, requireAuth } from '../auth.js';
import { loginBody, signupBody, validate } from '../validate.js';

export function authRoutes({ db, bcryptRounds, sessionTtlMs }) {
	const app = new Hono();
	const users = db.collection('users');
	// Compared against when the email is unknown so response time doesn't reveal which emails exist.
	const dummyHash = bcrypt.hashSync('not-a-real-password', bcryptRounds);

	app.post('/signup', validate('json', signupBody), async (c) => {
		const { email, password, username } = c.req.valid('json');
		if (await users.findOne({ email })) return c.json({ error: 'Email is already registered' }, 409);

		const doc = {
			email,
			username: username ?? email.split('@')[0].slice(0, 20),
			passwordHash: await bcrypt.hash(password, bcryptRounds),
			createdAt: new Date()
		};
		try {
			const { insertedId } = await users.insertOne(doc);
			const token = await createSession(db, insertedId, sessionTtlMs);
			return c.json({ user: publicUser({ ...doc, _id: insertedId }), token }, 201);
		} catch (error) {
			// Lost a race with another signup: the unique index is the real guard.
			if (error?.code === 11000) return c.json({ error: 'Email is already registered' }, 409);
			throw error;
		}
	});

	app.post('/login', validate('json', loginBody), async (c) => {
		const { email, password } = c.req.valid('json');
		const user = await users.findOne({ email });
		const ok = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
		if (!user || !ok) return c.json({ error: 'Invalid email or password' }, 401);
		const token = await createSession(db, user._id, sessionTtlMs);
		return c.json({ user: publicUser(user), token }, 200);
	});

	app.post('/logout', requireAuth(db), async (c) => {
		await destroySession(db, c.get('token'));
		return c.json({ ok: true }, 200);
	});

	app.get('/me', requireAuth(db), (c) => c.json({ user: publicUser(c.get('user')) }, 200));

	return app;
}

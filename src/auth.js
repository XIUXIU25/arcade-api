import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';

export const publicUser = (user) => ({ id: user._id.toString(), email: user.email, username: user.username });

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function bearerToken(c) {
	const header = c.req.header('Authorization') ?? '';
	const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
	return match ? match[1] : null;
}

/** Create a server-side session and return the opaque token the client keeps. */
export async function createSession(db, userId, ttlMs) {
	const token = randomBytes(32).toString('hex');
	const now = new Date();
	await db.collection('sessions').insertOne({
		tokenHash: hashToken(token),
		userId: new ObjectId(userId),
		createdAt: now,
		expiresAt: new Date(now.getTime() + ttlMs)
	});
	return token;
}

export async function destroySession(db, token) {
	await db.collection('sessions').deleteOne({ tokenHash: hashToken(token) });
}

async function resolveUser(db, token) {
	if (!token) return null;
	const session = await db.collection('sessions').findOne({ tokenHash: hashToken(token) });
	if (!session || session.expiresAt <= new Date()) return null;
	const user = await db.collection('users').findOne({ _id: session.userId });
	return user ?? null;
}

/** Populate c.var.user when a valid session token is sent; never rejects. */
export const optionalAuth = (db) => async (c, next) => {
	const token = bearerToken(c);
	c.set('token', token);
	c.set('user', await resolveUser(db, token));
	await next();
};

/** Reject with 401 unless a valid session token is sent. */
export const requireAuth = (db) => async (c, next) => {
	const token = bearerToken(c);
	const user = await resolveUser(db, token);
	if (!user) return c.json({ error: 'Authentication required' }, 401);
	c.set('token', token);
	c.set('user', user);
	await next();
};

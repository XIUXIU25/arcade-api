import { MongoClient } from 'mongodb';

/** Connect to MongoDB and make sure the indexes the API relies on exist. */
export async function connect(uri, dbName) {
	const client = new MongoClient(uri);
	await client.connect();
	const db = client.db(dbName);
	await ensureIndexes(db);
	return { client, db };
}

export async function ensureIndexes(db) {
	await Promise.all([
		// Uniqueness of email is enforced by the database, not just the route.
		db.collection('users').createIndex({ email: 1 }, { unique: true }),
		db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
		// MongoDB removes expired sessions on its own.
		db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
		db.collection('games').createIndex({ status: 1, createdAt: -1 }),
		db.collection('games').createIndex({ playerIds: 1 })
	]);
}

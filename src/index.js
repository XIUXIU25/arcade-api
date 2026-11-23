import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { connect } from './db.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
	process.exit(1);
}

const { client, db } = await connect(uri, process.env.DB_NAME ?? 'arcade');
const app = createApp({
	db,
	bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
	sessionTtlMs: Number(process.env.SESSION_TTL_DAYS ?? 7) * 24 * 60 * 60 * 1000
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
	console.log(`arcade-api listening on :${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		server.close();
		client.close().finally(() => process.exit(0));
	});
}

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth.js';
import { gameRoutes } from './routes/games.js';

/**
 * Build the Hono app around an already-connected database so tests can inject their own.
 * This API is only meant to be called by the SvelteKit server, so CORS is deliberately not enabled.
 */
export function createApp({ db, bcryptRounds = 12, sessionTtlMs = 7 * 24 * 60 * 60 * 1000 }) {
	const app = new Hono();

	app.get('/api/health', (c) => c.json({ ok: true }, 200));
	app.route('/api/auth', authRoutes({ db, bcryptRounds, sessionTtlMs }));
	app.route('/api/games', gameRoutes({ db }));

	app.notFound((c) => c.json({ error: 'Not found' }, 404));

	app.onError((error, c) => {
		if (error instanceof HTTPException) {
			return c.json({ error: error.message || 'Request failed' }, error.status);
		}
		console.error(error);
		return c.json({ error: 'Internal server error' }, 500);
	});

	return app;
}

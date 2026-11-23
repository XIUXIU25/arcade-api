import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

/** zod-validator wrapper that answers invalid input with a uniform 400. */
export function validate(target, schema) {
	return zValidator(target, schema, (result, c) => {
		if (!result.success) {
			return c.json(
				{
					error: 'Invalid request',
					details: result.error.issues.map((issue) => ({
						path: issue.path.join('.'),
						message: issue.message
					}))
				},
				400
			);
		}
	});
}

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24 character hex id');

export const idParam = z.object({ id: objectId });

export const signupBody = z.object({
	email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
	password: z.string().min(8, 'must be at least 8 characters').max(72, 'must be at most 72 characters'),
	username: z.string().trim().min(3).max(20).regex(/^[\w.-]+$/, 'letters, numbers, _ . - only').optional()
});

export const loginBody = z.object({
	email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
	password: z.string().min(1).max(72)
});

export const shotBody = z.object({
	x: z.number().int().min(0).max(9),
	y: z.number().int().min(0).max(9)
});

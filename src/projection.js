import { getSunkShips } from '@xiuxiuy/arcade-core';

const emptyBoard = (board) => ({ size: board.size, ships: [], shots: [] });

/** What a viewer may know about the other player's board while the game is live. */
function hiddenFleet(board) {
	return { size: board.size, ships: getSunkShips(board), shots: board.shots };
}

const player = (users, id) => {
	if (!id) return null;
	const user = users.get(id.toString());
	return { id: id.toString(), username: user?.username ?? 'unknown' };
};

export function viewerIndex(game, userId) {
	if (!userId) return null;
	const index = game.playerIds.findIndex((id) => id && id.equals(userId));
	return index === -1 ? null : index;
}

/**
 * Build the response for one viewer. This is the only place a game document is
 * turned into JSON, so the opponent's unsunk ships can never leak elsewhere.
 * `users` maps user id strings to user documents.
 *
 * Finished games are fully revealed and are shown from player 0's side to
 * anyone who did not play (`you` is null).
 */
export function projectGame(game, userId, users) {
	const you = viewerIndex(game, userId);
	const side = you ?? 0;
	const other = 1 - side;
	const complete = game.status === 'complete';
	const winner = game.winner;

	let opponentBoard;
	if (complete) opponentBoard = game.boards[other];
	else if (game.playerIds[other]) opponentBoard = hiddenFleet(game.boards[other]);
	else opponentBoard = emptyBoard(game.boards[other]);

	return {
		id: game._id.toString(),
		status: game.status,
		players: game.playerIds.map((id) => player(users, id)),
		you,
		turn: game.status === 'active' ? game.turn : null,
		yourTurn: you !== null && game.status === 'active' && game.turn === you,
		winner,
		outcome: complete && you !== null ? (winner === you ? 'won' : 'lost') : null,
		yourBoard: game.boards[side],
		opponentBoard,
		createdAt: game.createdAt,
		updatedAt: game.updatedAt
	};
}

/** Lightweight row for the game list: no boards at all. */
export function summarizeGame(game, userId, users) {
	const you = viewerIndex(game, userId);
	return {
		id: game._id.toString(),
		status: game.status,
		players: game.playerIds.map((id) => player(users, id)),
		you,
		yourTurn: you !== null && game.status === 'active' && game.turn === you,
		winner: game.winner,
		createdAt: game.createdAt
	};
}

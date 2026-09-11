export function createWorkerExecutionSummary() {
	return {
		status: { completed: 0, blocked: 0, failed: 0, cancelled: 0, interrupted: 0, other: 0 },
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		messages: { user: 0, assistant: 0, total: 0 },
		toolCalls: 0,
		toolResults: 0,
		hydration: { readCalls: 0, bytes: 0, skillEntryReads: 0, referenceReads: 0, distinctFiles: 0 },
		lastTerminal: null,
		recent: [],
	};
}

function addFinite(left, right) {
	return left + (Number.isFinite(right) ? right : 0);
}

export function workerObservationMetrics(stats) {
	const session = stats?.session;
	const tokens = session?.tokens;
	if (!session || !tokens) return undefined;
	const number = (value) => Number.isFinite(value) ? value : 0;
	const contextPercent = Number.isFinite(session.contextUsage?.percent)
		? Math.max(0, Math.min(100, session.contextUsage.percent))
		: undefined;
	return {
		input: number(tokens.input),
		output: number(tokens.output),
		cacheRead: number(tokens.cacheRead),
		cacheWrite: number(tokens.cacheWrite),
		total: number(tokens.total),
		cost: number(session.cost),
		toolCalls: number(session.toolCalls),
		toolResults: number(session.toolResults),
		messages: number(session.totalMessages),
		...(contextPercent !== undefined ? { contextPercent } : {}),
	};
}

export function workerObservationRow(task) {
	const metrics = workerObservationMetrics(task?.executionStats);
	return {
		id: String(task?.id || ""),
		role: String(task?.role || "explore"),
		status: String(task?.status || "unknown"),
		...(metrics ? { metrics } : {}),
	};
}

export function observeWorkerExecutionSummary(summary, task) {
	const next = {
		...summary,
		status: { ...summary.status },
		tokens: { ...summary.tokens },
		messages: { ...summary.messages },
		hydration: { ...summary.hydration },
		lastTerminal: summary.lastTerminal,
		recent: [...(summary.recent || [])],
	};
	const status = String(task?.status || "other");
	if (Object.prototype.hasOwnProperty.call(next.status, status)) next.status[status] += 1;
	else next.status.other += 1;
	const stats = task?.executionStats?.session;
	if (stats) {
		for (const key of Object.keys(next.tokens)) next.tokens[key] = addFinite(next.tokens[key], stats.tokens?.[key]);
		next.cost = addFinite(next.cost, stats.cost);
		next.messages.user = addFinite(next.messages.user, stats.userMessages);
		next.messages.assistant = addFinite(next.messages.assistant, stats.assistantMessages);
		next.messages.total = addFinite(next.messages.total, stats.totalMessages);
		next.toolCalls = addFinite(next.toolCalls, stats.toolCalls);
		next.toolResults = addFinite(next.toolResults, stats.toolResults);
	}
	const hydration = task?.executionStats?.instructionHydration;
	if (hydration) {
		for (const key of Object.keys(next.hydration)) next.hydration[key] = addFinite(next.hydration[key], hydration[key]);
	}
	const row = workerObservationRow(task);
	next.lastTerminal = { taskId: row.id, role: row.role, status: row.status };
	next.recent = [...next.recent.filter((item) => item.id !== row.id), row].slice(-16);
	return next;
}

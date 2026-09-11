import crypto from "node:crypto";

function stable(value) {
	if (value == null) return "";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${key}:${stable(value[key])}`).join("|")}}`;
	return String(value);
}

function responsibilityMaterial(workState, currentResponsibility) {
	const responsibility = currentResponsibility || workState.frontier?.currentResponsibility || null;
	if (!responsibility) return null;
	if (responsibility.kind === "todo") {
		const task = (workState.todoTasks || []).find((item) => String(item.id) === String(responsibility.id));
		return task ? { kind: "todo", id: task.id, status: task.status, content: task.content, blocker: task.blocker, reentryCondition: task.reentryCondition } : responsibility;
	}
	if (responsibility.kind === "worker" || responsibility.kind === "worker_terminal") {
		const task = (workState.tasks || []).find((item) => String(item.id) === String(responsibility.id));
		if (!task) return responsibility;
		const dependencyIds = [...new Set([...(task.dependsOn || []), ...(task.dependencies || [])].map(String))].sort();
		const dependencies = dependencyIds.map((id) => {
			const dependency = (workState.tasks || []).find((item) => String(item.id) === id);
			return dependency ? { id, revision: dependency.revision, status: dependency.status, blocker: dependency.blocker } : { id, status: "missing" };
		});
		return { kind: responsibility.kind, id: task.id, revision: task.revision, status: task.status, resultRef: task.resultRef, blocker: task.blocker, reentryCondition: task.reentryCondition || task.nextAction, dependencies };
	}
	if (responsibility.kind === "plan") {
		return workState.plan ? { kind: "plan", id: responsibility.id, revision: workState.plan.revision, status: workState.plan.status, artifactRef: workState.plan.artifactRef } : responsibility;
	}
	if (responsibility.kind === "checkpoint") {
		return workState.checkpoint ? { kind: "checkpoint", id: responsibility.id, nextAction: workState.checkpoint.nextAction, unresolved: workState.checkpoint.unresolved || [] } : responsibility;
	}
	if (responsibility.kind === "goal") {
		return workState.goal ? { kind: "goal", id: workState.goal.goalId, revision: workState.goal.revision, status: workState.goal.status, blocker: workState.goal.blocker, reentryCondition: workState.goal.reentryCondition } : responsibility;
	}
	return responsibility;
}

export function progressSignature(workState = {}, currentResponsibility = workState.frontier?.currentResponsibility) {
	const material = {
		goalId: workState.goal?.goalId || null,
		responsibility: responsibilityMaterial(workState, currentResponsibility),
	};
	return crypto.createHash("sha256").update(stable(material)).digest("hex");
}

export function shouldContinue(workState = {}, runtimeState = {}) {
	const goal = workState.goal;
	if (!goal || goal.status !== "active") return { shouldContinue: false, reason: "goal_not_active" };
	if (goal.continuationMode !== "auto") return { shouldContinue: false, reason: "manual_continuation" };
	if (runtimeState.rootIdle === false) return { shouldContinue: false, reason: "root_busy" };
	if (runtimeState.humanGate || runtimeState.hardGate || runtimeState.mutationInFlight || runtimeState.unknownInFlight) return { shouldContinue: false, reason: "gate" };
	const ready = Array.isArray(runtimeState.readyBranches)
		? runtimeState.readyBranches.length > 0
		: Boolean(workState.frontier?.ready ?? runtimeState.frontierReady ?? workState.frontierReady);
	if (!ready) return { shouldContinue: false, reason: "no_ready_frontier" };
	const signature = progressSignature(workState, runtimeState.currentResponsibility);
	if (runtimeState.blockerFingerprint && runtimeState.reentryConditionSatisfied !== true && runtimeState.previousSignature === signature) {
		return { shouldContinue: false, reason: "stable_blocker", signature, blocked: true, blockerFingerprint: runtimeState.blockerFingerprint };
	}
	if (runtimeState.previousSignature && runtimeState.previousSignature === signature) {
		if (runtimeState.reanchorUsed) return { shouldContinue: false, reason: "no_progress", signature, blocked: true };
		return { shouldContinue: true, reason: "reanchor", signature, reanchor: true };
	}
	return { shouldContinue: true, reason: "frontier_ready", signature, reanchor: false };
}

export class ContinuationController {
	#queued = null;
	#epoch = 0;
	#lastSignature = null;
	#reanchorUsed = false;

	constructor({ enqueue = async () => {}, getState = () => ({}) } = {}) {
		this.enqueue = enqueue;
		this.getState = getState;
	}

	invalidate(reason = "user_input") {
		this.#epoch += 1;
		this.#queued = null;
		this.#reanchorUsed = false;
		return { epoch: this.#epoch, reason };
	}

	async onSettled(event = "agent_settled") {
		const state = this.getState();
		const decision = shouldContinue(state.workState, {
			...state.runtimeState,
			previousSignature: this.#lastSignature,
			reanchorUsed: this.#reanchorUsed,
			rootIdle: state.runtimeState?.rootIdle !== false,
		});
		if (!decision.shouldContinue) {
			if (decision.blocked) state.onBlocked?.({ reason: decision.reason, signature: decision.signature });
			return decision;
		}
		if (this.#queued) return { ...decision, queued: false, reason: "single_flight" };
		const epoch = this.#epoch;
		const frontierSignature = decision.signature;
		this.#queued = { epoch, frontierSignature, event };
		try {
			const delivery = await this.enqueue({
				epoch,
				frontierSignature,
				event,
				reanchor: Boolean(decision.reanchor),
				goalId: state.workState?.goal?.goalId,
				goalRevision: state.workState?.goal?.revision,
				currentResponsibility: state.runtimeState?.currentResponsibility || state.workState?.frontier?.currentResponsibility,
				authorityRevision: state.runtimeState?.authorityRevision,
			});
			// Some legacy hosts can only report that sendUserMessage() was invoked,
			// not that the message entered the real session queue. Preserve the
			// frontier in that case: a later settle/recovery may retry it, whereas
			// consuming the signature here would permanently lose continuation.
			if (delivery && typeof delivery === "object" && delivery.deliveryAck === false) {
				return { ...decision, queued: false, reason: "delivery_unknown", deliveryUnknown: true };
			}
			// Delivery acceptance is the commit point for continuation progress.
			// Failed/unknown sends must not consume the signature or the one-shot
			// re-anchor allowance.
			if (this.#epoch === epoch) {
				if (decision.reanchor) this.#reanchorUsed = true;
				this.#lastSignature = frontierSignature;
			}
			return { ...decision, queued: true };
		} finally {
			if (this.#queued?.epoch === epoch) this.#queued = null;
		}
	}

	get epoch() { return this.#epoch; }
	get queued() { return this.#queued; }
}

import { randomUUID } from 'node:crypto';
import { DropCalendar } from './drop-calendar.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(['purchased', 'paper-confirmed', 'missed', 'cancelled']);

export class Orchestrator {
  #calendar;
  #lanes;
  #clock;
  #sleep;
  #alerts;
  #logger;
  #states = new Map();
  #productLocks = new Set();
  #siteTails = new Map();
  #running = false;
  #safety;
  #ledger;
  #watchBackoff;
  #abortController;
  #active = new Set();
  #metrics;
  #tasks;
  #stateStore;
  #leaseOwner;

  constructor({
    calendar = new DropCalendar(), lanes = {}, clock = { now: Date.now }, sleep = wait,
    alerts, logger = console, safety, ledger,
    watchBackoff = (attempt) => Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1))),
    abortController = new AbortController(), metrics, tasks, stateStore,
    leaseOwner = `${process.pid}:${randomUUID()}`,
  } = {}) {
    this.#calendar = calendar;
    this.#lanes = lanes;
    this.#clock = clock;
    this.#sleep = sleep;
    this.#alerts = alerts;
    this.#logger = logger;
    this.#safety = safety;
    this.#ledger = ledger;
    this.#watchBackoff = watchBackoff;
    this.#abortController = abortController;
    this.#metrics = metrics;
    this.#tasks = tasks;
    this.#stateStore = stateStore;
    this.#leaseOwner = leaseOwner;
  }

  async #notify(method, details) {
    try {
      await this.#alerts?.[method]?.(details);
    } catch (error) {
      this.#logger?.warn?.(`Alert delivery failed: ${method}`, error);
    }
  }

  async #recordResult(id, status, details) {
    try {
      await this.#calendar?.markResult?.(id, status, details);
    } catch (error) {
      this.#logger?.error?.(`Could not record ${status} for ${id}`, error);
    }
  }

  async #runScheduled(site, drop, lane, state) {
    state.fired = true;
    try {
      const result = await lane.run({
        drop, site, signal: this.#abortController.signal,
        onDetection: (event) => this.handleDetection({ site, drop, ...event }),
      });
      if (result?.status) await this.#recordResult(drop.id, result.status, { site, result });
      return result;
    } catch (error) {
      await this.#recordResult(drop.id, 'missed', { site, error: error.message });
      await this.#notify('purchaseFailed', { site, product: drop.id, error: error.message });
      return { status: 'missed', error };
    }
  }

  async tick() {
    const drops = await this.#calendar.allDrops();
    const now = this.#clock.now();
    const work = [];
    for (const drop of drops) {
      if (TERMINAL.has(drop.status)) continue;
      const untilDropMs = Date.parse(drop.time) - now;
      if (untilDropMs > 24 * 60 * 60_000) continue;
      for (const site of drop.sites) {
        const lane = this.#lanes[site];
        if (!lane) continue;
        const key = `${drop.id}:${site}`;
        const state = this.#states.get(key) ?? {};
        this.#states.set(key, state);

        if (drop.type === 'surprise') {
          if (!state.watching && !state.completed && now >= (state.retryAt ?? 0) && !this.#abortController.signal.aborted) {
            state.watching = true;
            const watchPromise = Promise.resolve().then(() => lane.watch?.({
              drop, site, cadence: 'surprise', signal: this.#abortController.signal,
              onDetection: (event) => this.handleDetection({ site, drop, ...event }),
            }));
            state.watchPromise = watchPromise;
            this.#active.add(watchPromise);
            watchPromise.then((result) => {
              this.#metrics?.increment?.('surprise_watcher', { outcome: 'completed', site });
              if (['purchased', 'paper-confirmed', 'duplicate-suppressed'].includes(result?.status)) {
                state.failures = 0;
                state.completed = true;
              } else if (!this.#abortController.signal.aborted) {
                state.failures = (state.failures ?? 0) + 1;
                state.retryAt = this.#clock.now() + this.#watchBackoff(state.failures);
              }
            }).catch((error) => {
              if (!this.#abortController.signal.aborted) {
                this.#metrics?.increment?.('surprise_watcher', { outcome: 'failed', site });
                state.failures = (state.failures ?? 0) + 1;
                state.retryAt = this.#clock.now() + this.#watchBackoff(state.failures);
                this.#logger?.error?.(`Surprise watcher failed for ${key}`, error);
              }
            }).finally(() => {
              state.watching = false;
              this.#active.delete(watchPromise);
            });
          }
          continue;
        }
        if (untilDropMs <= 5 * 60_000 && !state.warmed) {
          state.warmed = true;
          work.push(Promise.resolve(lane.warmup?.({
            drop, site, signal: this.#abortController.signal,
            onDetection: (event) => this.handleDetection({ site, drop, ...event }),
          })));
        }
        if (untilDropMs <= 30_000 && !state.fullThrottle) {
          state.fullThrottle = true;
          work.push(Promise.resolve(lane.fullThrottle?.({ drop, site })));
        }
        if (untilDropMs <= 0 && !state.fired) work.push(this.#runScheduled(site, drop, lane, state));
      }
    }
    return Promise.all(work);
  }

  async #withSiteSlot(site, operation) {
    const previous = this.#siteTails.get(site) ?? Promise.resolve();
    let release;
    const ownTurn = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => ownTurn);
    this.#siteTails.set(site, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#siteTails.get(site) === tail) this.#siteTails.delete(site);
    }
  }

  async handleDetection({ site, drop, ...context }) {
    const productKey = drop.id;
    if (this.#productLocks.has(productKey)) return { status: 'duplicate-suppressed' };
    this.#productLocks.add(productKey);
    let reservation;
    let task;
    const transitionTask = async (state, details = {}) => {
      if (!task || !this.#tasks?.transition) return null;
      task = await this.#tasks.transition(task.id, state, { details, leaseOwner: this.#leaseOwner });
      return task;
    };
    try {
      if (this.#tasks?.ensure) {
        const ensured = await this.#tasks.ensure({
          key: drop.id, site, product: drop.id, dropId: drop.id,
          account: context.account,
          details: { detectedAt: context.detectedAt, amount: context.amount ?? drop.price },
        });
        task = ensured.task;
        if (!ensured.created && task.state !== 'detected') {
          return { status: 'duplicate-suppressed', reason: `task-${task.state}`, taskId: task.id };
        }
        if (this.#tasks.acquireLease) {
          try {
            task = await this.#tasks.acquireLease(task.id, { owner: this.#leaseOwner });
          } catch (error) {
            if (error?.code === 'SCALPER_TASK_LEASED') {
              return { status: 'duplicate-suppressed', reason: 'task-leased', taskId: task.id };
            }
            throw error;
          }
        }
      }
      // Monitor/parser quantity fields describe observed stock. Only the
      // explicit purchaseQuantity field may request more than one unit.
      const quantity = Number(drop.purchaseQuantity ?? context.purchaseQuantity ?? 1);
      const amount = context.amount ?? drop.price;
      let decision;
      try {
        decision = this.#safety?.authorize
          ? await this.#safety.authorize({ site, drop, amount, quantity, ...context })
          : { allowed: true, live: false, reason: 'no-policy' };
      } catch (error) {
        this.#logger?.error?.('Safety policy failed closed', error);
        decision = { allowed: false, reason: 'safety-error' };
      }
      if (!decision.allowed) {
        this.#metrics?.increment?.('checkout_safety', { outcome: 'blocked', reason: decision.reason, site });
        await this.#notify('purchaseFailed', { site, product: drop.id, error: `safety:${decision.reason}` });
        await transitionTask('blocked', { reason: decision.reason });
        return { status: 'safety-blocked', reason: decision.reason };
      }
      let taskAuthorized = false;
      if (decision.live && this.#ledger?.reserve) {
        const reservationInput = {
          key: drop.id, site, product: drop.id, account: context.account,
          amount: Number.isFinite(Number(amount)) ? Number(amount) : 0, quantity,
          dayStart: decision.dayStart, dailyLimit: decision.dailyLimit,
        };
        const transactional = this.#stateStore?.tasks === this.#tasks
          && this.#stateStore?.ledger === this.#ledger
          && this.#stateStore?.reserveForTask;
        const reserved = transactional
          ? await this.#stateStore.reserveForTask({ ...reservationInput, taskId: task.id, leaseOwner: this.#leaseOwner })
          : await this.#ledger.reserve(reservationInput);
        if (!reserved.ok) {
          if (reserved.reason === 'daily-limit') {
            this.#metrics?.increment?.('checkout_safety', { outcome: 'blocked', reason: reserved.reason, site });
            await this.#notify('purchaseFailed', { site, product: drop.id, error: `safety:${reserved.reason}` });
            await transitionTask('blocked', { reason: reserved.reason });
            return { status: 'safety-blocked', reason: reserved.reason };
          }
          return { status: 'duplicate-suppressed', reason: reserved.reason };
        }
        reservation = reserved.reservation;
        if (reserved.task) {
          task = reserved.task;
          taskAuthorized = true;
        }
      }
      if (!taskAuthorized) await transitionTask('authorized', { live: decision.live, quantity, amount, reservationId: reservation?.id });
      // Detection paging is observational and must not sit on the checkout
      // critical path. #notify contains its own error boundary.
      void this.#notify('dropDetected', { site, product: drop.id });
      if (Number.isFinite(context.detectedAt)) this.#metrics?.observe?.('detection_to_checkout_ms', Math.max(0, this.#clock.now() - context.detectedAt), { site });
      return await this.#withSiteSlot(site, async () => {
        const lane = this.#lanes[site];
        if (!lane?.checkout) throw new Error(`No checkout lane configured for ${site}`);
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          let commitStarted = false;
          try {
            if (attempt === 2 && lane.isStillAvailable && !await lane.isStillAvailable({ drop, site, ...context })) {
              const error = new Error('The product is no longer available before the retry');
              error.code = 'SCALPER_ITEM_UNAVAILABLE';
              throw error;
            }
            const result = await lane.checkout({
              drop, site, attempt, ...context,
              taskId: task?.id,
              beforeCommit: async (details = {}) => {
                let checkpoint;
                try {
                  const recheck = this.#safety?.recheckAtCommit ?? this.#safety?.authorize;
                  checkpoint = recheck
                    ? await recheck.call(this.#safety, { site, drop, amount, quantity, ...context })
                    : { allowed: false, live: decision.live, reason: 'safety-unavailable' };
                } catch (cause) {
                  this.#logger?.error?.('Pre-commit safety policy failed closed', cause);
                  checkpoint = { allowed: false, live: decision.live, reason: 'safety-error' };
                }
                if (!checkpoint.allowed || (decision.live && checkpoint.live !== true)) {
                  const reason = checkpoint.allowed ? 'live-disabled' : checkpoint.reason;
                  this.#metrics?.increment?.('checkout_safety', { outcome: 'blocked-precommit', reason, site });
                  const error = new Error(`Pre-commit safety check blocked checkout: ${reason}`);
                  error.code = 'SCALPER_PRECOMMIT_BLOCKED';
                  error.reason = reason;
                  error.details = details;
                  throw error;
                }
                this.#metrics?.increment?.('checkout_safety', { outcome: 'allowed-precommit', site });
                return checkpoint;
              },
              onProgress: async (event) => {
                if (['submitting', 'confirming'].includes(event.state)) commitStarted = true;
                return transitionTask(event.state, { ...event, attempt });
              },
            });
            if (result?.status === 'safety-blocked') {
              if (reservation && this.#ledger?.fail) {
                try {
                  await this.#ledger.fail(reservation.id, { reason: result.reason, defects: result.defects });
                } catch (error) {
                  this.#logger?.error?.('Could not fail safety-blocked ledger reservation', error);
                }
              }
              try { await transitionTask('blocked', { reason: result.reason, defects: result.defects }); } catch (error) {
                this.#logger?.error?.('Could not mark safety-blocked purchase task blocked', error);
              }
              this.#metrics?.increment?.('checkout_safety', { outcome: 'blocked-precommit', reason: result.reason, site });
              await this.#recordResult(drop.id, 'blocked', { site, reason: result.reason, defects: result.defects });
              await this.#notify('purchaseFailed', { site, product: drop.id, error: `safety:${result.reason}` });
              return { ...result, taskId: task?.id };
            }
            this.#metrics?.increment?.('checkout_attempts', { outcome: 'succeeded', site, attempt: String(attempt) });
            let taskFinalized = false;
            if (reservation && this.#ledger?.complete) {
              try {
                const transactional = this.#stateStore?.tasks === this.#tasks
                  && this.#stateStore?.ledger === this.#ledger
                  && this.#stateStore?.completePurchase;
                if (transactional) {
                  const completed = await this.#stateStore.completePurchase({
                    taskId: task.id, reservationId: reservation.id, orderId: result?.orderId,
                    status: result?.status ?? 'purchased', details: { attempt }, leaseOwner: this.#leaseOwner,
                  });
                  task = completed.task;
                  taskFinalized = true;
                } else {
                  await this.#ledger.complete(reservation.id, { status: result?.status ?? 'purchased', orderId: result?.orderId });
                }
              } catch (error) {
                this.#logger?.error?.('Could not finalize purchase ledger reservation', error);
                const finalizationError = new Error('The checkout succeeded but its durable ledger record could not be finalized');
                finalizationError.code = 'SCALPER_LEDGER_FINALIZATION_FAILED';
                finalizationError.cause = error;
                try {
                  await this.#ledger?.uncertain?.(reservation.id, { error: finalizationError.message, orderId: result?.orderId });
                } catch (uncertainError) {
                  this.#logger?.error?.('Could not mark failed ledger finalization uncertain', uncertainError);
                }
                try { await transitionTask('uncertain', { error: finalizationError.message, orderId: result?.orderId }); } catch (taskError) {
                  this.#logger?.error?.('Could not mark purchase task uncertain after ledger failure', taskError);
                }
                await this.#recordResult(drop.id, 'uncertain', { site, error: finalizationError.message, orderId: result?.orderId });
                await this.#notify('purchaseUncertain', {
                  site, product: drop.id, error: finalizationError.message, orderId: result?.orderId, taskId: task?.id,
                });
                return { status: 'uncertain', error: finalizationError, orderId: result?.orderId, taskId: task?.id };
              }
            }
            if (!taskFinalized) {
              try {
                await transitionTask(result?.status === 'paper-confirmed' ? 'paper-confirmed' : 'purchased', {
                  orderId: result?.orderId, attempt,
                });
              } catch (error) {
                this.#logger?.error?.('Could not finalize purchase task state', error);
              }
            }
            await this.#recordResult(drop.id, result?.status ?? 'purchased', { site, attempt, result });
            await this.#notify('purchaseConfirmed', { site, product: drop.id, orderId: result?.orderId });
            return result;
          } catch (caught) {
            this.#metrics?.increment?.('checkout_attempts', { outcome: 'failed', site, attempt: String(attempt) });
            let error = caught;
            if (commitStarted && !['SCALPER_ORDER_STATUS_UNCERTAIN', 'SCALPER_PRECOMMIT_BLOCKED'].includes(error?.code)) {
              const uncertain = new Error('Checkout failed after order submission began; the order status is uncertain');
              uncertain.code = 'SCALPER_ORDER_STATUS_UNCERTAIN';
              uncertain.cause = error;
              error = uncertain;
            }
            lastError = error;
            if (['SCALPER_ORDER_STATUS_UNCERTAIN', 'SCALPER_PRECOMMIT_BLOCKED', 'SCALPER_ITEM_UNAVAILABLE'].includes(error?.code)) break;
            if (attempt < 2) await transitionTask('retrying', { error: error?.message, completedAttempt: attempt, nextAttempt: attempt + 1 });
          }
        }
        if (lastError?.code === 'SCALPER_PRECOMMIT_BLOCKED') {
          if (reservation && this.#ledger?.fail) {
            try {
              await this.#ledger.fail(reservation.id, { error: lastError.message, reason: lastError.reason });
            } catch (error) {
              this.#logger?.error?.('Could not fail pre-commit ledger reservation', error);
            }
          }
          try { await transitionTask('blocked', { reason: lastError.reason, phase: 'precommit' }); } catch (error) {
            this.#logger?.error?.('Could not mark pre-commit purchase task blocked', error);
          }
          await this.#notify('purchaseFailed', { site, product: drop.id, error: `safety:${lastError.reason}` });
          return { status: 'safety-blocked', reason: lastError.reason, phase: 'precommit', taskId: task?.id };
        }
        if (lastError?.code === 'SCALPER_ORDER_STATUS_UNCERTAIN') {
          if (reservation && this.#ledger?.uncertain) {
            try {
              await this.#ledger.uncertain(reservation.id, { error: lastError.message });
            } catch (error) {
              this.#logger?.error?.('Could not mark purchase ledger reservation uncertain', error);
            }
          }
          try { await transitionTask('uncertain', { error: lastError.message }); } catch (error) {
            this.#logger?.error?.('Could not mark purchase task uncertain', error);
          }
          await this.#recordResult(drop.id, 'uncertain', { site, error: lastError.message });
          await this.#notify('purchaseUncertain', { site, product: drop.id, error: lastError.message, taskId: task?.id });
          return { status: 'uncertain', error: lastError, taskId: task?.id };
        }
        if (reservation && this.#ledger?.fail) {
          try {
            await this.#ledger.fail(reservation.id, { error: lastError?.message });
          } catch (error) {
            this.#logger?.error?.('Could not fail purchase ledger reservation', error);
          }
        }
        try { await transitionTask('failed', { error: lastError?.message }); } catch (error) {
          this.#logger?.error?.('Could not mark purchase task failed', error);
        }
        await this.#recordResult(drop.id, 'missed', { site, error: lastError?.message });
        await this.#notify('purchaseFailed', { site, product: drop.id, error: lastError?.message });
        return { status: 'missed', error: lastError };
      });
    } finally {
      this.#productLocks.delete(productKey);
    }
  }

  async runDrop(drop, { site = drop?.sites?.[0] } = {}) {
    if (!drop || !site) throw new Error('runDrop requires a drop and site');
    if (this.#tasks?.list) {
      const existing = (await this.#tasks.list({ site, limit: 1_000 })).find((task) => task.key === drop.id);
      if (existing && existing.state !== 'detected') {
        return { status: 'duplicate-suppressed', reason: `task-${existing.state}`, taskId: existing.id };
      }
    }
    const lane = this.#lanes[site];
    if (!lane?.run) throw new Error(`No runnable lane configured for ${site}`);
    return this.#runScheduled(site, drop, lane, {});
  }

  async watch({ intervalMs = 1_000, random = Math.random, signal } = {}) {
    this.#running = true;
    while (this.#running && !signal?.aborted && !this.#abortController.signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.#logger?.error?.('Orchestrator tick failed', error);
      }
      const jittered = Math.round(intervalMs * (0.9 + random() * 0.2));
      await this.#sleep(jittered);
    }
  }

  async stop() {
    this.#running = false;
    if (!this.#abortController.signal.aborted) this.#abortController.abort(new Error('Orchestrator stopped'));
    await Promise.allSettled([...this.#active]);
  }
}

export function createOrchestrator(options) {
  return new Orchestrator(options);
}

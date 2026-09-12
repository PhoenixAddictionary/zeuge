"use strict";
/**
 * ledger/lock — a simple exclusive lock via an atomic `wx`-mode lockfile, with retry/backoff.
 * Writes go write-temp-then-rename under this lock so a crash mid-write never leaves a
 * half-written ledger file in place.
 *
 * Stale-lock recovery: process LIVENESS is now authoritative, never
 * age. The prior design removed any lock older than 5 minutes REGARDLESS of whether its holder
 * was still alive — append does a whole-file read and rewrite under this lock, so a slow but
 * perfectly healthy holder (a big segment, a loaded machine) was ordinary, and a second process
 * could delete its lock out from under it and both append at once: silent ledger corruption,
 * caused by treating age as an ALTERNATIVE to liveness.
 *
 * The rule now: a lock is removable only when its holder is PROVABLY gone
 * (`process.kill(pid, 0)` throws `ESRCH`). A live holder is refused with `LOCK_HELD` no matter
 * how old its lock is. When liveness cannot be determined at all — `EPERM` (a pid owned by
 * another user), any other unexpected errno, or a lock file with no usable pid — the lock is
 * refused rather than stolen; the specific reason is recorded on the refusal (`holderPid`,
 * `detail`) so a stuck ledger can be diagnosed without guessing. A maximum age
 * (`STALE_AGE_MS`) is kept, but only as an ADDITIONAL condition on an ALREADY-dead holder,
 * never as a substitute for the liveness check: a lock whose holder just crashed is required to
 * also be a little old before removal, as a small guard against yanking a lock the instant its
 * holder's pid disappears from the process table.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LedgerLockHeldError = void 0;
exports.withLedgerLock = withLedgerLock;
exports.writeAtomic = writeAtomic;
const fs = __importStar(require("node:fs"));
const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 20;
/** A dead holder's lock must also be at least this old before it is removed — see module doc:
 *  this is an additional guard on an already-proven-dead holder, never a way to remove a lock
 *  from a holder we cannot prove is dead. */
const STALE_AGE_MS = 30_000;
function sleepSync(ms) {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
}
function readLockInfo(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0 && typeof parsed.acquired_at === "number") {
            return parsed;
        }
        return null;
    }
    catch {
        return null; // unreadable/unparseable/race-removed: caller treats this as "cannot tell, not stale"
    }
}
/** Probes whether `pid` is alive. `ALIVE`/`DEAD` are the only two answers that ever authorize a
 *  decision; `UNKNOWN` (permission denied, or any other unexpected errno) means exactly that —
 *  it must never be treated as "dead" just because the OS didn't say "alive." */
function probeLiveness(pid) {
    try {
        process.kill(pid, 0);
        return { liveness: "ALIVE" }; // no error: signal 0 delivered, process exists (and we have permission)
    }
    catch (err) {
        const code = err.code;
        if (code === "ESRCH")
            return { liveness: "DEAD" };
        return { liveness: "UNKNOWN", errnoCode: code ?? "UNKNOWN_ERRNO" };
    }
}
/** The single authority for whether a lock may be removed. Liveness decides; age (on an
 *  already-dead holder only) can additionally withhold removal, but can never grant it. */
function assessLock(info, now) {
    if (!info)
        return { removable: false, reason: "UNREADABLE_LOCK_INFO", pid: null };
    const { liveness, errnoCode } = probeLiveness(info.pid);
    if (liveness === "UNKNOWN") {
        return { removable: false, reason: "UNKNOWN_LIVENESS", pid: info.pid, errnoCode };
    }
    if (liveness === "ALIVE") {
        return { removable: false, reason: "HOLDER_ALIVE", pid: info.pid };
    }
    // liveness === "DEAD"
    const age = now - info.acquired_at;
    if (age <= STALE_AGE_MS) {
        return { removable: false, reason: "HOLDER_DEAD_TOO_YOUNG", pid: info.pid };
    }
    return { removable: true, reason: "HOLDER_DEAD", pid: info.pid };
}
function decisionMessage(decision) {
    switch (decision.reason) {
        case "HOLDER_ALIVE":
            return `holder pid ${decision.pid} is alive`;
        case "HOLDER_DEAD_TOO_YOUNG":
            return `holder pid ${decision.pid} is dead but the lock is not yet past the ${STALE_AGE_MS}ms minimum age`;
        case "UNKNOWN_LIVENESS":
            return `cannot determine whether holder pid ${decision.pid} is alive (process.kill errno: ${decision.errnoCode})`;
        case "UNREADABLE_LOCK_INFO":
            return "lock file is missing, unparseable, or carries no usable pid";
        case "HOLDER_DEAD":
            return `holder pid ${decision.pid} is dead`;
    }
}
/** Attempts to acquire the lock, recovering exactly one stale holder along the way. Returns a
 *  typed LOCK_HELD refusal (never throws) when the deadline is reached without acquiring it —
 *  carrying the holder pid (if known) and the exact decision reason for diagnosis. */
function acquireLock(lockPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let staleRemovalAttempted = false;
    let lastDecision = { removable: false, reason: "UNREADABLE_LOCK_INFO", pid: null };
    while (true) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            const info = { pid: process.pid, acquired_at: Date.now() };
            try {
                fs.writeSync(fd, JSON.stringify(info));
            }
            catch {
                /* best-effort: an unwritable lock body still holds the lock via the fd itself */
            }
            return { ok: true, fd };
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            const now = Date.now();
            const info = readLockInfo(lockPath);
            const decision = assessLock(info, now);
            lastDecision = decision;
            if (decision.removable && !staleRemovalAttempted) {
                staleRemovalAttempted = true;
                try {
                    fs.unlinkSync(lockPath);
                }
                catch {
                    /* race: someone else already removed or replaced it — fall through to retry loop */
                }
                continue; // retry acquisition once, immediately, after removing the stale lock
            }
            if (now > deadline) {
                return { ok: false, reason: "LOCK_HELD", holderPid: lastDecision.pid, detail: lastDecision.reason, detailMessage: decisionMessage(lastDecision) };
            }
            sleepSync(RETRY_DELAY_MS);
        }
    }
}
class LedgerLockHeldError extends Error {
    code = "LOCK_HELD";
    holderPid;
    detail;
    constructor(lockPath, holderPid, detail, detailMessage) {
        super(`ledger lock held: ${lockPath} (${detailMessage})`);
        this.name = "LedgerLockHeldError";
        this.holderPid = holderPid;
        this.detail = detail;
    }
}
exports.LedgerLockHeldError = LedgerLockHeldError;
function withLedgerLock(ledgerPath, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const lockPath = ledgerPath + ".lock";
    const acquired = acquireLock(lockPath, timeoutMs);
    if (!acquired.ok) {
        throw new LedgerLockHeldError(lockPath, acquired.holderPid, acquired.detail, acquired.detailMessage);
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.closeSync(acquired.fd);
        }
        catch {
            /* already closed */
        }
        try {
            fs.unlinkSync(lockPath);
        }
        catch {
            /* already removed */
        }
    }
}
/** Write `content` to `filePath` via write-temp-then-rename (same-directory temp for atomic rename). */
function writeAtomic(filePath, content) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
}

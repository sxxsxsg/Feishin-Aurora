// Per-server concurrency limit for batched (fan-out) reads.
//
// One user action can fan out into one request per item - for example opening
// an artist with 120 albums fires one getAlbum per album. Without a limit all
// of those requests start at once and hit the server as a burst. This module
// caps how many batched reads run at the same time, per server, so each server
// gets its own budget and a slow server cannot starve another one.
//
// Only fan-out batch reads go through here. Single interactive requests
// (playback, search, one getAlbum, ...) bypass the limiter, so real playback
// always has room. No fixed delay is added to any request.
//
// Extension point: background work (cover art, prefetch, waveform) can get
// its own lower-priority channel later by adding a second per-server limiter
// (for example keyed `${serverId}:background` with a limit of 1 or 2) and
// routing those tasks through it. That work is intentionally untouched here.

export const DEFAULT_BATCH_READ_CONCURRENCY = 4;

interface ConcurrencyLimiter {
    acquire: () => Promise<ReleaseFn>;
    run: <T>(task: () => Promise<T>) => Promise<T>;
}

type ReleaseFn = () => void;

class Semaphore implements ConcurrencyLimiter {
    private available: number;
    private waiters: Array<() => void> = [];

    constructor(limit: number) {
        this.available = Math.max(1, limit);
    }

    acquire(): Promise<ReleaseFn> {
        if (this.available > 0) {
            this.available -= 1;
            return Promise.resolve(() => this.release());
        }

        return new Promise<ReleaseFn>((resolve) => {
            this.waiters.push(() => resolve(() => this.release()));
        });
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        const release = await this.acquire();

        try {
            return await task();
        } finally {
            release();
        }
    }

    private release(): void {
        const next = this.waiters.shift();

        if (next) {
            next();
            return;
        }

        this.available += 1;
    }
}

const serverBatchLimiters = new Map<string, ConcurrencyLimiter>();

export const getServerBatchLimiter = (
    serverId: string,
    limit: number = DEFAULT_BATCH_READ_CONCURRENCY,
): ConcurrencyLimiter => {
    let limiter = serverBatchLimiters.get(serverId);

    if (!limiter) {
        limiter = new Semaphore(limit);
        serverBatchLimiters.set(serverId, limiter);
    }

    return limiter;
};

// Run thunks through the server's batch-read budget, keeping Promise.all
// semantics: results stay in input order and the first rejection wins.
// Tasks are thunks (not promises) so nothing starts before a slot is free.
export const mapBatchedReads = <T>(
    serverId: string,
    tasks: ReadonlyArray<() => Promise<T>>,
): Promise<T[]> => {
    const limiter = getServerBatchLimiter(serverId);
    return Promise.all(tasks.map((task) => limiter.run(task)));
};

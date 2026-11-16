// Shared artist/album reads for the Subsonic controller.
//
// getSongList and getSongListCount (and the album list/count pair) used to
// run the same getArtist + getAlbum fan-out twice: once to build the list,
// once to count it. This module runs each underlying read once and shares
// the result between callers, with two layers:
//
// - In-flight dedup: while a read for the same server + id is running,
//   later callers wait on the same promise instead of firing a new request.
// - Short-lived result cache: finished reads are reused for
//   ARTIST_READ_CACHE_TTL_MS, so a list call followed by a count call
//   within the window costs no extra requests.
//
// The cache is keyed per server (a slow server cannot poison another one)
// and capped per server, with the oldest entries evicted first. Failed
// reads are not cached: the entry is dropped so the next call retries.
//
// Actual HTTP still goes through the per-server batch-read limiter from
// concurrency-limit, so peak HTTP concurrency stays capped even when many
// callers share these helpers. Callers must use plain Promise.all over
// these helpers - never wrap them in mapBatchedReads, which would take a
// second limiter slot for the same read and can deadlock.

import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';
import type { ServerInferResponses } from '@ts-rest/core';

import { getServerBatchLimiter } from '/@/renderer/api/concurrency-limit';
import { contract, ssApiClient } from '/@/renderer/api/subsonic/subsonic-api';

// How long a finished artist/album read is reused before it is fetched again.
export const ARTIST_READ_CACHE_TTL_MS = 60_000;

// Upper bound on cached reads per server, per map: the albums map and the
// artists map each hold up to this many entries.
const MAX_CACHED_READS_PER_SERVER = 1000;

export type SubsonicApiClientProps = {
    forceRemoteUrl?: boolean;
    server?: null | ServerListItemWithCredential;
    serverId: string;
    signal?: AbortSignal;
};

type AlbumResponse = ServerInferResponses<typeof contract.getAlbum>;
type ArtistResponse = ServerInferResponses<typeof contract.getArtist>;

interface CachedRead<T> {
    completedAt: null | number;
    promise: Promise<T>;
}

interface ServerReadCache {
    albums: Map<string, CachedRead<AlbumResponse>>;
    artists: Map<string, CachedRead<ArtistResponse>>;
}

const serverCaches = new Map<string, ServerReadCache>();

const getServerCache = (serverId: string): ServerReadCache => {
    let cache = serverCaches.get(serverId);

    if (!cache) {
        cache = { albums: new Map(), artists: new Map() };
        serverCaches.set(serverId, cache);
    }

    return cache;
};

const getOrFetch = <T>(
    cache: Map<string, CachedRead<T>>,
    serverId: string,
    key: string,
    fetch: () => Promise<T>,
): Promise<T> => {
    const existing = cache.get(key);

    if (existing) {
        // In-flight: share the running request. Finished and fresh: reuse it.
        if (existing.completedAt === null) {
            return existing.promise;
        }

        if (Date.now() - existing.completedAt < ARTIST_READ_CACHE_TTL_MS) {
            return existing.promise;
        }

        cache.delete(key);
    }

    while (cache.size >= MAX_CACHED_READS_PER_SERVER) {
        const oldestKey = cache.keys().next().value;

        if (oldestKey === undefined) {
            break;
        }

        cache.delete(oldestKey);
    }

    // The handlers only run as microtasks, after this synchronous block
    // has finished, so they always see the entry fully built.
    const entry: CachedRead<T> = {
        completedAt: null,
        promise: getServerBatchLimiter(serverId)
            .run(fetch)
            .then(
                (result) => {
                    if ((result as { status?: unknown }).status === 200) {
                        entry.completedAt = Date.now();
                    } else if (cache.get(key) === entry) {
                        cache.delete(key);
                    }

                    return result;
                },
                (error: unknown) => {
                    if (cache.get(key) === entry) {
                        cache.delete(key);
                    }

                    throw error;
                },
            ),
    };

    cache.set(key, entry);

    return entry.promise;
};

// Fetch one artist (its album list), shared across list/count callers.
export const getSharedArtist = (
    apiClientProps: SubsonicApiClientProps,
    artistId: string,
): Promise<ArtistResponse> =>
    getOrFetch(
        getServerCache(apiClientProps.serverId).artists,
        apiClientProps.serverId,
        artistId,
        () =>
            ssApiClient({
                forceRemoteUrl: apiClientProps.forceRemoteUrl,
                server: apiClientProps.server ?? null,
            }).getArtist({
                query: {
                    id: artistId,
                },
            }),
    );

// Fetch one album (its song list), shared across list/count callers.
export const getSharedAlbum = (
    apiClientProps: SubsonicApiClientProps,
    albumId: string,
): Promise<AlbumResponse> =>
    getOrFetch(
        getServerCache(apiClientProps.serverId).albums,
        apiClientProps.serverId,
        albumId,
        () =>
            ssApiClient({
                forceRemoteUrl: apiClientProps.forceRemoteUrl,
                server: apiClientProps.server ?? null,
            }).getAlbum({
                query: {
                    id: albumId,
                },
            }),
    );

import type {
    DefaultOptions,
    QueryOptions,
    UseInfiniteQueryOptions,
    UseMutationOptions,
    UseQueryOptions,
} from '@tanstack/react-query';

import { QueryCache, QueryClient } from '@tanstack/react-query';

import { toast } from '/@/shared/components/toast/toast';

const MAX_QUERY_RETRIES = 3;
const serverCooldownUntil = new Map<string, number>();

const getStatus = (error: any) => error?.response?.status ?? error?.status;

// One key per server, not per endpoint: the axios clients are created without
// a baseURL, so error.config.url is the full request URL and differs per
// endpoint. The origin is the same for every request to one server.
const serverKey = (error: any) => {
    const raw = error?.config?.baseURL ?? error?.config?.url;
    if (typeof raw !== 'string' || raw.length === 0) {
        return undefined;
    }
    try {
        return new URL(raw).origin;
    } catch {
        return raw;
    }
};

const shouldRetry = (failureCount: number, error: any) => {
    const status = getStatus(error);
    if (status === 401 || status === 403 || status === 400 || status === 422) {
        return false;
    }

    return failureCount < MAX_QUERY_RETRIES;
};

const retryDelay = (attempt: number, error: any) => {
    const status = getStatus(error);
    const serverId = serverKey(error);
    const remaining =
        typeof serverId === 'string'
            ? Math.max(0, (serverCooldownUntil.get(serverId) ?? 0) - Date.now())
            : 0;
    if (status === 429 && typeof serverId === 'string') {
        const header = error?.response?.headers?.['retry-after'];
        const seconds = Number(header);
        const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 1000 * 2 ** attempt;
        serverCooldownUntil.set(serverId, Date.now() + Math.max(delay, remaining));
        return Math.max(delay, remaining);
    }
    if (remaining > 0) {
        return remaining;
    }
    return Math.min(1000 * 2 ** attempt, 30000);
};

const queryCache = new QueryCache({
    onError: (error: any, query) => {
        if (query.state.data !== undefined) {
            console.error(error);
            toast.show({ message: `${error.message}`, type: 'error' });
        }
    },
});

const queryConfig: DefaultOptions = {
    mutations: {
        retry: process.env.NODE_ENV === 'production' ? 3 : false,
    },
    queries: {
        gcTime: 1000 * 20, // 20 seconds
        refetchOnWindowFocus: false,
        retry: process.env.NODE_ENV === 'production' ? shouldRetry : false,
        retryDelay,
        staleTime: 1000 * 10, // 10 seconds
        throwOnError: (error: any) => {
            return error?.response?.status >= 500;
        },
    },
};

export const queryClient = new QueryClient({
    defaultOptions: queryConfig,
    queryCache,
});

export type InfiniteQueryHookArgs<T> = {
    options?: UseInfiniteQueryOptions;
    query: T;
    serverId: string | undefined;
};

export type MutationHookArgs = {
    options?: MutationOptions;
};

export type MutationOptions = {
    mutationKey: UseMutationOptions['mutationKey'];
    onError?: (err: any) => void;
    onSettled?: any;
    onSuccess?: any;
    retry?: UseQueryOptions['retry'];
    retryDelay?: UseQueryOptions['retryDelay'];
    useErrorBoundary?: boolean;
};

export type QueryHookArgs<T> = {
    options?: UseQueryHookOptions;
    query: T;
    serverId: string;
};

type UseQueryHookOptions = {
    enabled?: boolean;
    gcTime?: QueryOptions['gcTime'];
    // initialData?: UseQueryOptions['initialData'];
    // initialDataUpdatedAt?: UseQueryOptions['initialDataUpdatedAt'];
    meta?: UseQueryOptions['meta'];
    networkMode?: UseQueryOptions['networkMode'];
    notifyOnChangeProps?: UseQueryOptions['notifyOnChangeProps'];
    placeholderData?: (prev: any) => any;
    // queryFn?: UseQueryOptions['queryFn'];
    queryKey?: UseQueryOptions['queryKey'];
    queryKeyHashFn?: UseQueryOptions['queryKeyHashFn'];
    refetchInterval?: number;
    refetchIntervalInBackground?: UseQueryOptions['refetchIntervalInBackground'];
    refetchOnMount?: boolean;
    refetchOnReconnect?: boolean;
    refetchOnWindowFocus?: boolean;
    retry?: UseQueryOptions['retry'];
    retryDelay?: UseQueryOptions['retryDelay'];
    retryOnMount?: UseQueryOptions['retryOnMount'];
    // select?: UseQueryOptions['select'];
    staleTime?: number;
    structuralSharing?: UseQueryOptions['structuralSharing'];
    subscribed?: UseQueryOptions['subscribed'];
    throwOnError?: boolean;
};

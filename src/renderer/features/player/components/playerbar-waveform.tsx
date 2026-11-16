import { useWavesurfer } from '@wavesurfer/react';
import formatDuration from 'format-duration';
import { del, get, keys, set } from 'idb-keyval';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CustomPlayerbarSlider } from './playerbar-slider';
import styles from './playerbar-waveform.module.css';

import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { PlayerbarSeekSlider } from '/@/renderer/features/player/components/playerbar-seek-slider';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    BarAlign,
    usePlaybackSettings,
    usePlayerbarSlider,
    usePlayerSong,
    usePlayerTimestamp,
} from '/@/renderer/store';
import { useAppThemeColors, useColorScheme } from '/@/renderer/themes/use-app-theme';
import { Text } from '/@/shared/components/text/text';

// streams without Content-Length report "Infinity" until decoded; seeking then sets a NaN currentTime
const getFiniteDuration = (wavesurfer: { getDuration: () => number }) => {
    const duration = wavesurfer.getDuration();
    return Number.isFinite(duration) ? duration : 0;
};

const pruneWaveformPeaks = async () => {
    try {
        const allKeys = await keys();
        const peakKeys = allKeys.filter(
            (key): key is string => typeof key === 'string' && key.startsWith('["waveform-peaks",'),
        );
        const currentKeys = peakKeys.filter((key) => {
            try {
                return JSON.parse(key)[1] === 2;
            } catch {
                return false;
            }
        });
        for (const key of peakKeys) {
            if (!currentKeys.includes(key)) await del(key);
        }
        if (currentKeys.length <= 1000) return;
        const entries: { at: number; key: string }[] = [];
        for (const key of currentKeys) {
            const value = await get<{ at?: number }>(key);
            entries.push({ at: typeof value?.at === 'number' ? value.at : 0, key });
        }
        entries.sort((a, b) => a.at - b.at);
        for (const { key } of entries.slice(0, entries.length - 1000)) await del(key);
    } catch {
        // Cache maintenance must never affect waveform playback.
    }
};

export const PlayerbarWaveform = () => {
    const currentSong = usePlayerSong();
    const playerbarSlider = usePlayerbarSlider();
    const currentTime = usePlayerTimestamp();
    const containerRef = useRef<HTMLDivElement>(null);
    const audioElementRef = useRef<HTMLAudioElement>(document.createElement('audio'));
    const { mediaSeekToTimestamp } = usePlayer();
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [tooltipPosition, setTooltipPosition] = useState<null | { x: number; y: number }>(null);
    const [tooltipValue, setTooltipValue] = useState(0);
    const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastSeekValueRef = useRef<null | number>(null);
    const containerPositionRef = useRef<DOMRect | null>(null);

    const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;

    const cacheKey = currentSong
        ? JSON.stringify(['waveform-peaks', 2, currentSong._serverId, currentSong.id])
        : null;

    const { transcode } = usePlaybackSettings();
    const streamUrl = useSongUrl(currentSong, true, {
        bitrate: 64,
        enabled: transcode.enabled,
        format: 'mp3',
    });

    const { color } = useAppThemeColors();
    const primaryColor = (color['--theme-colors-primary'] as string) || 'rgb(53, 116, 252)';

    const colorScheme = useColorScheme();

    const waveColor = useMemo(() => {
        return colorScheme === 'dark' ? 'rgba(96, 96, 96, 1)' : 'rgba(96, 96, 96, 1)';
    }, [colorScheme]);

    const cursorColor = useMemo(() => {
        return colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)';
    }, [colorScheme]);

    const { wavesurfer } = useWavesurfer({
        barAlign:
            playerbarSlider?.barAlign === BarAlign.CENTER ? undefined : playerbarSlider?.barAlign,
        barGap: playerbarSlider?.barGap,
        barRadius: playerbarSlider?.barRadius,
        barWidth: playerbarSlider?.barWidth,
        container: containerRef,
        cursorColor,
        cursorWidth: 2,
        fillParent: true,
        height: 18,
        interact: false,
        media: audioElementRef.current,
        normalize: playerbarSlider?.stretched ?? false,
        progressColor: primaryColor,
        waveColor,
    });

    // Reset loading state when stream URL changes and ensure media is muted
    useEffect(() => {
        setIsLoading(true);
        setHasError(false);
    }, [streamUrl]);

    // Handle waveform ready state
    useEffect(() => {
        if (!wavesurfer || !streamUrl) return;

        // The wavesurfer instance is shared across stream URLs, and this
        // effect subscribes before its (delayed) load actually starts. Guard
        // against events that do not belong to this effect's own load:
        // `cancelled` rejects events after the URL has moved on, and
        // `loadStarted` rejects a still-in-flight previous load's `ready`
        // (which would otherwise clear the loading state for the wrong
        // track and hide the seek bar over an empty/stale waveform).
        let cancelled = false;
        let loadStarted = false;
        let loadingCached = false;

        const handleReady = () => {
            if (cancelled || !loadStarted) return;
            setIsLoading(false);
            setHasError(false);
            const mediaElement = wavesurfer.getMediaElement();
            if (mediaElement) {
                mediaElement.muted = true;
                mediaElement.volume = 0;
            }
        };

        // A load failure previously left the waveform canvas empty with no
        // seek control (the fallback slider only showed while loading), so
        // the progress bar disappeared until the app was restarted. Surface
        // real failures so the fallback slider is rendered again. AbortError
        // is the expected outcome of a superseded load and is ignored.
        const handleError = (error?: unknown) => {
            if (cancelled || !loadStarted || loadingCached) return;
            if (error instanceof Error && error.name === 'AbortError') return;
            setIsLoading(false);
            setHasError(true);
        };

        wavesurfer.on('ready', handleReady);
        wavesurfer.on('error', handleError);

        const waveformTimeout = setTimeout(
            async () => {
                let cached: undefined | { at: number; peaks: number[][] };
                try {
                    cached = cacheKey
                        ? await get<{ at: number; peaks: number[][] }>(cacheKey)
                        : undefined;
                    if (cached && Array.isArray(cached.peaks)) {
                        cached.at = Date.now();
                        await set(cacheKey!, cached);
                        await pruneWaveformPeaks();
                    }
                } catch {
                    // Cache access must never prevent the normal waveform load.
                }
                if (cancelled) return;
                loadStarted = true;
                try {
                    if (cached?.peaks && Number.isFinite(songDuration) && songDuration > 0) {
                        loadingCached = true;
                        try {
                            await wavesurfer.load('', cached.peaks, songDuration);
                            return;
                        } catch {
                            if (cancelled) return;
                            // Unusable cached peaks fall back to the original stream.
                        } finally {
                            loadingCached = false;
                        }
                    }
                    await wavesurfer.load(streamUrl);
                    if (cancelled || !cacheKey) return;
                    try {
                        await set(cacheKey, { at: Date.now(), peaks: wavesurfer.exportPeaks() });
                        await pruneWaveformPeaks();
                    } catch {
                        // Export/storage failure leaves the rendered waveform intact.
                    }
                } catch (error: unknown) {
                    if (cancelled || (error instanceof Error && error.name === 'AbortError')) {
                        return;
                    }
                    setIsLoading(false);
                    setHasError(true);
                }
            },
            playerbarSlider?.loadingDelay ? playerbarSlider.loadingDelay * 1000 : 2000,
        );

        return () => {
            cancelled = true;
            wavesurfer.un('ready', handleReady);
            wavesurfer.un('error', handleError);
            clearTimeout(waveformTimeout);
        };
    }, [wavesurfer, streamUrl, playerbarSlider.loadingDelay, cacheKey, songDuration]);

    useEffect(() => {
        if (!wavesurfer) return;

        // Ensure waveform never plays - it's just for visualization
        wavesurfer.setVolume(0);

        const muteMediaElement = () => {
            const mediaElement = wavesurfer.getMediaElement();
            if (mediaElement) {
                mediaElement.muted = true;
                mediaElement.volume = 0;
            }
        };

        muteMediaElement();

        const preventPlay = () => {
            wavesurfer.pause();
            muteMediaElement(); // Ensure it stays muted
        };

        wavesurfer.on('play', preventPlay);

        return () => {
            wavesurfer.un('play', preventPlay);
        };
    }, [wavesurfer]);

    // Handle drag start on waveform
    useEffect(() => {
        if (!wavesurfer || !songDuration || !containerRef.current) return;

        const container = containerRef.current;
        let isDraggingLocal = false;

        const handleMouseDown = (e: MouseEvent) => {
            if (!wavesurfer) return;
            const duration = getFiniteDuration(wavesurfer);
            if (duration <= 0) return;

            isDraggingLocal = true;
            setIsDragging(true);

            // Cancel any pending timeout
            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
            }

            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDraggingLocal || !wavesurfer) return;

            const duration = getFiniteDuration(wavesurfer);
            if (duration <= 0) return;

            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleMouseUp = () => {
            if (!isDraggingLocal || !wavesurfer) return;

            isDraggingLocal = false;
            const duration = getFiniteDuration(wavesurfer);
            const seekTime = lastSeekValueRef.current ?? wavesurfer.getCurrentTime();

            setTooltipPosition(null);

            if (duration > 0 && seekTime >= 0) {
                mediaSeekToTimestamp(seekTime);
                lastSeekValueRef.current = seekTime;

                // Set a fallback timeout to clear dragging state
                seekTimeoutRef.current = setTimeout(() => {
                    setIsDragging(false);
                    lastSeekValueRef.current = null;
                    seekTimeoutRef.current = null;
                }, 1000);
            } else {
                setIsDragging(false);
            }
        };

        // Handle touch events for mobile
        const handleTouchStart = (e: TouchEvent) => {
            if (!wavesurfer) return;
            const duration = getFiniteDuration(wavesurfer);
            if (duration <= 0) return;

            isDraggingLocal = true;
            setIsDragging(true);

            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
            }

            const touch = e.touches[0];
            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = touch.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (!isDraggingLocal || !wavesurfer) return;
            e.preventDefault();

            const duration = getFiniteDuration(wavesurfer);
            if (duration <= 0) return;

            const touch = e.touches[0];
            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = touch.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleTouchEnd = () => {
            if (!isDraggingLocal || !wavesurfer) return;

            isDraggingLocal = false;
            const duration = getFiniteDuration(wavesurfer);
            const seekTime = lastSeekValueRef.current ?? wavesurfer.getCurrentTime();

            setTooltipPosition(null);

            if (duration > 0 && seekTime >= 0) {
                mediaSeekToTimestamp(seekTime);
                lastSeekValueRef.current = seekTime;

                seekTimeoutRef.current = setTimeout(() => {
                    setIsDragging(false);
                    lastSeekValueRef.current = null;
                    seekTimeoutRef.current = null;
                }, 1000);
            } else {
                setIsDragging(false);
            }
        };

        container.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        container.addEventListener('touchstart', handleTouchStart, { passive: false });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd);

        return () => {
            container.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
            }
        };
    }, [wavesurfer, songDuration, mediaSeekToTimestamp]);

    // Sync dragging state when currentTime catches up to seek value
    useEffect(() => {
        if (isDragging && lastSeekValueRef.current !== null) {
            const timeDiff = Math.abs(currentTime - lastSeekValueRef.current);
            if (timeDiff < 0.5) {
                setIsDragging(false);
                setTooltipPosition(null);
                // Keep lastSeekValueRef until mouseUp/touchEnd consumes it:
                // with cached peaks the media element never loads, so its
                // currentTime stays 0 and the drag target is the only
                // correct seek value. mouseUp clears the ref on its own.
                if (seekTimeoutRef.current) {
                    clearTimeout(seekTimeoutRef.current);
                    seekTimeoutRef.current = null;
                }
            }
        }
    }, [currentTime, isDragging]);

    // Update waveform progress based on player current time (only when not dragging)
    useEffect(() => {
        if (!wavesurfer || !songDuration || isDragging) return;

        const duration = getFiniteDuration(wavesurfer);
        if (duration > 0 && currentTime >= 0) {
            const ratio = currentTime / duration;
            wavesurfer.seekTo(ratio);
        }
    }, [wavesurfer, currentTime, songDuration, isDragging]);

    // Show disabled slider when there's no current song
    if (!currentSong) {
        return (
            <CustomPlayerbarSlider
                disabled
                max={100}
                min={0}
                onClick={(e) => {
                    e?.stopPropagation();
                }}
                size={6}
                value={0}
                w="100%"
            />
        );
    }

    return (
        <div
            className={styles.wavesurferContainer}
            onClick={(e) => {
                e?.stopPropagation();
            }}
            style={{ position: 'relative' }}
        >
            <motion.div
                animate={{ opacity: isLoading || hasError ? 0 : 1 }}
                className={styles.waveform}
                initial={{ opacity: 0 }}
                ref={containerRef}
                transition={{ duration: 0.2 }}
            />
            <AnimatePresence>
                {(isLoading || hasError) && (
                    <motion.div
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        initial={{ opacity: 0 }}
                        style={{
                            height: '100%',
                            left: 0,
                            position: 'absolute',
                            top: 3,
                            width: '100%',
                        }}
                        transition={{ duration: 0.2 }}
                    >
                        <PlayerbarSeekSlider max={songDuration} min={0} />
                    </motion.div>
                )}
            </AnimatePresence>
            {tooltipPosition && isDragging && (
                <motion.div
                    animate={{ opacity: 1, scale: 1, x: '-50%' }}
                    className={styles.tooltip}
                    initial={{ opacity: 0, scale: 0.8, x: '-50%' }}
                    style={{
                        left: `${tooltipPosition.x}px`,
                        position: 'fixed',
                        top: `${tooltipPosition.y - 40}px`,
                        zIndex: 1000,
                    }}
                    transition={{ duration: 0.15 }}
                >
                    <Text isNoSelect size="md">
                        {formatDuration(tooltipValue * 1000)}
                    </Text>
                </motion.div>
            )}
        </div>
    );
};

/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-empty-function */
// Node isolation only: real WaveSurfer loading, synthetic media/decoder/renderer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import WaveSurfer from 'wavesurfer.js';

const source = readFileSync(
    process.argv[2] || 'src/renderer/features/player/components/playerbar-waveform.tsx',
    'utf8',
);
const body = source
    .split('// Handle waveform ready state\n    useEffect(() => {')[1]
    .split('\n    }, [')[0];
const js = ts.transpile(body, { target: ts.ScriptTarget.ES2022 });
const duration = 240;
let fetches = 0;
let assignments = 0;
let rendered;
let src = '';
globalThis.window = { AbortController };
globalThis.AudioBuffer = class {};
globalThis.AudioContext = class {
    state = 'running';
    async close() {}
    async decodeAudioData() {
        return {
            duration,
            getChannelData: () => Float32Array.from([0, 0.5, -1, 0.25]),
            numberOfChannels: 1,
        };
    }
};
globalThis.fetch = async () => {
    fetches++;
    return new Response(new Blob(['audio'], { type: 'audio/mpeg' }));
};
const media = {
    canPlayType: () => 'probably',
    get currentTime() {
        return 0;
    },
    set currentTime(value) {},
    duration,
    paused: true,
    removeAttribute: () => {
        src = '';
        media.duration = 0;
    },
    get src() {
        return src;
    },
    set src(value) {
        assignments++;
        src = value;
        media.duration = duration;
    },
};
const wavesurfer = Object.create(WaveSurfer.prototype);
Object.assign(wavesurfer, {
    _loadVersion: 0,
    listeners: {},
    media,
    mediaSubscriptions: [],
    options: { media, sampleRate: 8000 },
    renderer: {
        render: (data) => {
            rendered = data;
        },
    },
});
const cache = new Map();
const cacheKeys = async () => [...cache.keys()];
const cacheDelete = async (key) => cache.delete(key);
const cacheGet = async (key) => cache.get(key);
// Extract the real prune function from the component source, the same way
// the load effect below is extracted: the component never exports it, and
// the effect calls it by name, so it must also be injected into the effect.
const pruneSplit = source.split('const pruneWaveformPeaks = async () => {');
const pruneWaveformPeaks =
    pruneSplit.length > 1
        ? new Function(
              'keys',
              'get',
              'del',
              ts.transpile(
                  'const pruneWaveformPeaks = async () => {' +
                      pruneSplit[1].split('\n};')[0] +
                      '\n};',
                  { target: ts.ScriptTarget.ES2022 },
              ) + '\nreturn pruneWaveformPeaks;',
          )(cacheKeys, cacheGet, cacheDelete)
        : // Baseline source predates the cap: no prune function to extract.
          async () => {};
let pendingLoad;
const load = wavesurfer.load.bind(wavesurfer);
wavesurfer.load = (...args) => {
    pendingLoad = load(...args);
    return pendingLoad;
};
let timer;
let failRead = false;
let failWrite = false;
const run = async () => {
    const effect = new Function(
        'wavesurfer',
        'streamUrl',
        'cacheKey',
        'songDuration',
        'playerbarSlider',
        'get',
        'set',
        'keys',
        'del',
        'pruneWaveformPeaks',
        'setIsLoading',
        'setHasError',
        'setTimeout',
        'clearTimeout',
        js,
    );
    const cleanup = effect(
        wavesurfer,
        'https://isolation.invalid/audio',
        'waveform-peaks-v1:server:song',
        duration,
        {},
        async (key) => {
            if (failRead) throw Error('read');
            return cache.get(key);
        },
        async (key, value) => {
            if (failWrite) throw Error('write');
            cache.set(key, structuredClone(value));
        },
        cacheKeys,
        cacheDelete,
        pruneWaveformPeaks,
        () => {},
        () => {},
        (callback) => {
            timer = callback;
        },
        () => {},
    );
    fetches = 0;
    assignments = 0;
    await timer();
    await pendingLoad;
    cleanup();
    return { assignments, duration: wavesurfer.getDuration(), fetches };
};
const first = await run();
const replay = await run();
console.log(JSON.stringify({ first, replay }));
if (process.argv.includes('--baseline')) {
    const handler = source.split('const handleMouseUp = () => {')[1].split('\n        };')[0];
    const expression = handler.match(/const seekTime = (.*);/)[1];
    console.log(
        'baseline seek at ratio=0.375:',
        new Function('wavesurfer', 'lastSeekValueRef', `return ${expression}`)(wavesurfer, {
            current: 90,
        }),
    );
    process.exit(0);
}
assert.equal(first.fetches, 1);
assert.equal(first.assignments, 1);
assert.equal(replay.fetches, 0);
assert.equal(replay.assignments, 0);
assert.equal(replay.duration, duration);
const peaks = [...cache.values()][0].peaks;
assert.deepEqual(Array.from(rendered.getChannelData(0)), Array.from(Float32Array.from(peaks[0])));
for (const name of ['handleMouseUp', 'handleTouchEnd']) {
    const handler = source.split(`const ${name} = () => {`)[1].split('\n        };')[0];
    const expression = handler.match(/const seekTime = (.*);/)[1];
    for (const ratio of [0, 0.375, 1]) {
        const value = new Function('wavesurfer', 'lastSeekValueRef', `return ${expression}`)(
            wavesurfer,
            { current: ratio * duration },
        );
        assert.equal(value, ratio * duration);
    }
}
console.log('peaks match; duration=240; mouse/touch seek: 0, 90, 240 (media currentTime=0)');
failRead = true;
assert.equal((await run()).fetches, 1);
failRead = false;
cache.clear();
failWrite = true;
assert.equal((await run()).fetches, 1);
assert.ok(rendered);
console.log('read/write failure fallback passed');

failWrite = false;
// Seed the exact key run() reads, with the current value shape, so this
// really exercises the invalid-peaks fallback instead of a cache miss.
cache.set('waveform-peaks-v1:server:song', { at: Date.now(), peaks: [[]] });
assert.equal((await run()).fetches, 1);
cache.clear();
const exportPeaks = wavesurfer.exportPeaks;
wavesurfer.exportPeaks = () => {
    throw Error('export');
};
assert.equal((await run()).fetches, 1);
assert.ok(rendered);
wavesurfer.exportPeaks = exportPeaks;
console.log('invalid peaks/export failure fallback passed');

cache.clear();
const now = Date.now();
for (let index = 0; index < 1001; index++) {
    cache.set(JSON.stringify(['waveform-peaks', 2, 'server', `song-${index}`]), {
        at: now + index,
        peaks: [[]],
    });
}
cache.set(JSON.stringify(['waveform-peaks', 1, 'server', 'legacy']), { at: now, peaks: [[]] });
await pruneWaveformPeaks();
const currentCacheKeys = [...cache.keys()].filter((key) => JSON.parse(key)[1] === 2);
assert.equal(currentCacheKeys.length, 1000);
assert.equal(cache.has(JSON.stringify(['waveform-peaks', 2, 'server', 'song-0'])), false);
assert.equal(cache.has(JSON.stringify(['waveform-peaks', 2, 'server', 'song-1000'])), true);
assert.equal(cache.has(JSON.stringify(['waveform-peaks', 1, 'server', 'legacy'])), false);
console.log('LRU cap: 1001 inserted, oldest and legacy removed, 1000 current entries remain');

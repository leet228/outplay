/**
 * Sound engine using Web Audio API
 * Plays sounds as overlay — does NOT interrupt background music
 * Uses AudioContext + fetch → decodeAudioData → buffer source
 */

const SOUND_FILES = {
  correct:    '/sounds/correct.wav',
  incorrect:  '/sounds/incorrect.wav',
  victory:    '/sounds/victory.mp3',
  defeat:     '/sounds/defeat.mp3',
  timer:      '/sounds/timer.wav',
  gameStart:  '/sounds/app-open.wav',   // reuse app-open for game start
  coin:       '/sounds/coin.wav',
  appOpen:    '/sounds/app-open.wav',
}

let audioCtx = null
const bufferCache = {}  // name → AudioBuffer
const activeNodes = {}  // name → AudioBufferSourceNode (for stopping loops/timer)
let pendingQueue = []   // sounds queued before audio unlock
let unlocked = false

// Volume levels (0-1)
let masterVolume = 1.0
let soundEnabled = true

function getContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
  return audioCtx
}

/** Unlock audio — call from splash screen or on first user gesture */
export function unlockAudio() {
  if (unlocked) return
  try {
    const ctx = getContext()
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (unlocked) return
        unlocked = true
        _flushQueue()
      })
    } else {
      unlocked = true
      _flushQueue()
    }
  } catch {}
}

function _flushQueue() {
  // Play only appOpen from queue (skip stale game sounds)
  const appOpenItem = pendingQueue.find(q => q.name === 'appOpen')
  pendingQueue = []
  if (appOpenItem) playSound(appOpenItem.name, appOpenItem.opts)
}

// Listen for first user interaction to unlock audio
if (typeof window !== 'undefined') {
  const events = ['touchstart', 'touchend', 'mousedown', 'click', 'keydown']
  const handler = () => {
    unlockAudio()
    events.forEach(e => window.removeEventListener(e, handler, true))
  }
  events.forEach(e => window.addEventListener(e, handler, { capture: true, once: false, passive: true }))
}

/** Preload a sound into buffer cache */
async function preload(name) {
  if (bufferCache[name]) return bufferCache[name]
  const url = SOUND_FILES[name]
  if (!url) return null
  try {
    const ctx = getContext()
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    bufferCache[name] = audioBuffer
    return audioBuffer
  } catch (e) {
    console.warn(`[Sound] Failed to preload "${name}":`, e)
    return null
  }
}

/** Preload all sounds */
export async function preloadAll() {
  const names = Object.keys(SOUND_FILES)
  await Promise.allSettled(names.map(n => preload(n)))
}

/**
 * Play a sound by name
 * @param {string} name - Sound name from SOUND_FILES
 * @param {object} opts - { volume?: number, loop?: boolean }
 * @returns {AudioBufferSourceNode|null}
 */
export function playSound(name, opts = {}) {
  if (!soundEnabled) return null
  const url = SOUND_FILES[name]
  if (!url) return null

  const ctx = getContext()

  // If audio not unlocked yet, queue this sound (will play on first touch)
  if (ctx.state === 'suspended' && !unlocked) {
    pendingQueue.push({ name, opts })
    return null
  }

  const buffer = bufferCache[name]

  if (buffer) {
    return _playBuffer(name, buffer, ctx, opts)
  }

  // Load on demand if not preloaded
  preload(name).then(buf => {
    if (buf) _playBuffer(name, buf, ctx, opts)
  })
  return null
}

function _playBuffer(name, buffer, ctx, opts = {}) {
  const { volume = 1.0, loop = false } = opts

  // Stop previous instance of this sound if playing
  stopSound(name)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = loop

  const gainNode = ctx.createGain()
  gainNode.gain.value = volume * masterVolume

  source.connect(gainNode)
  gainNode.connect(ctx.destination)

  source.start(0)
  activeNodes[name] = source

  source.onended = () => {
    if (activeNodes[name] === source) {
      delete activeNodes[name]
    }
  }

  return source
}

/** Stop a specific sound */
export function stopSound(name) {
  if (activeNodes[name]) {
    try {
      activeNodes[name].stop()
    } catch {}
    delete activeNodes[name]
  }
}

/** Stop all playing sounds */
export function stopAll() {
  Object.keys(activeNodes).forEach(name => stopSound(name))
}

/** Enable/disable sounds */
export function setSoundEnabled(enabled) {
  soundEnabled = enabled
  if (!enabled) stopAll()
  try {
    localStorage.setItem('outplay_sound', enabled ? '1' : '0')
  } catch {}
}

/** Check if sounds are enabled */
export function isSoundEnabled() {
  return soundEnabled
}

/** Set master volume (0-1) */
export function setMasterVolume(vol) {
  masterVolume = Math.max(0, Math.min(1, vol))
  try {
    localStorage.setItem('outplay_volume', String(masterVolume))
  } catch {}
}

/** Initialize sound settings from localStorage */
export function initSounds() {
  try {
    const stored = localStorage.getItem('outplay_sound')
    if (stored === '0') soundEnabled = false
    const vol = localStorage.getItem('outplay_volume')
    if (vol) masterVolume = parseFloat(vol) || 1.0
  } catch {}
}

// ── Convenience helpers ──

export const sound = {
  correct:   () => playSound('correct', { volume: 0.7 }),
  incorrect: () => playSound('incorrect', { volume: 0.7 }),
  victory:   () => playSound('victory', { volume: 0.8 }),
  defeat:    () => playSound('defeat', { volume: 0.8 }),
  coin:      () => playSound('coin', { volume: 0.6 }),
  gameStart: () => playSound('gameStart', { volume: 0.5 }),
  appOpen:   () => {
    // Try Web Audio API first, fallback to HTML Audio for webview compat
    const node = playSound('appOpen', { volume: 0.4 })
    if (!node && soundEnabled) {
      try {
        const a = new Audio('/sounds/app-open.wav')
        a.volume = 0.4 * masterVolume
        a.play().catch(() => {})
      } catch {}
    }
  },

  // Timer: plays the 5s countdown tick sound
  timerStart: () => playSound('timer', { volume: 0.5 }),
  timerStop:  () => stopSound('timer'),
}

export default sound

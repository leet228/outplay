/**
 * Sound engine — hybrid approach:
 * 1. HTML5 Audio pool for one-shot sounds (works in WebView autoplay)
 * 2. Web Audio API fallback for precise control (timer stop, etc.)
 *
 * HTML5 Audio in Telegram WebView typically allows autoplay because
 * the user gesture of opening the mini app counts as activation.
 * Web Audio API AudioContext is stricter, so we use it only when needed.
 */

const SOUND_FILES = {
  correct:    '/sounds/correct.wav',
  incorrect:  '/sounds/incorrect.wav',
  victory:    '/sounds/victory.mp3',
  defeat:     '/sounds/defeat.mp3',
  timer:      '/sounds/timer.wav',
  gameStart:  '/sounds/app-open.wav',
  coin:       '/sounds/coin.wav',
}

// Volume levels (0-1)
let masterVolume = 1.0
let soundEnabled = true

// ── HTML5 Audio pool (primary — best WebView compat) ──
const audioPool = {}  // name → Audio element

function getAudioElement(name) {
  const url = SOUND_FILES[name]
  if (!url) return null
  if (!audioPool[name]) {
    audioPool[name] = new Audio(url)
    audioPool[name].preload = 'auto'
  }
  return audioPool[name]
}

/** Preload all sounds via HTML5 Audio */
export function preloadAll() {
  Object.keys(SOUND_FILES).forEach(name => {
    const a = getAudioElement(name)
    if (a) a.load()
  })
}

// ── Web Audio API (secondary — for timer stop control) ──
let audioCtx = null
const waBuffers = {}    // name → AudioBuffer
const waNodes = {}      // name → AudioBufferSourceNode

function getWAContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

async function waPreload(name) {
  if (waBuffers[name]) return
  const url = SOUND_FILES[name]
  if (!url) return
  try {
    const ctx = getWAContext()
    const resp = await fetch(url)
    const buf = await resp.arrayBuffer()
    waBuffers[name] = await ctx.decodeAudioData(buf)
  } catch {}
}

function waPlay(name, volume = 1.0) {
  try {
    const ctx = getWAContext()
    if (ctx.state === 'suspended') return false
    const buffer = waBuffers[name]
    if (!buffer) return false

    waStop(name)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = volume * masterVolume
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start(0)
    waNodes[name] = source
    source.onended = () => { if (waNodes[name] === source) delete waNodes[name] }
    return true
  } catch { return false }
}

function waStop(name) {
  if (waNodes[name]) {
    try { waNodes[name].stop() } catch {}
    delete waNodes[name]
  }
}

// ── Unlock Web Audio on first gesture (for timer etc.) ──
if (typeof window !== 'undefined') {
  const events = ['touchstart', 'touchend', 'mousedown', 'click']
  const handler = () => {
    try {
      const ctx = getWAContext()
      if (ctx.state === 'suspended') ctx.resume()
    } catch {}
    // Preload timer into Web Audio API for stoppable playback
    waPreload('timer')
    events.forEach(e => window.removeEventListener(e, handler, true))
  }
  events.forEach(e => window.addEventListener(e, handler, { capture: true, passive: true }))
}

// ── Main play function using HTML5 Audio ──

function playHTML(name, volume = 1.0) {
  if (!soundEnabled) return
  const a = getAudioElement(name)
  if (!a) return
  try {
    a.volume = volume * masterVolume
    a.currentTime = 0
    a.play().catch(() => {
      // HTML5 Audio blocked — try Web Audio API as fallback
      waPlay(name, volume)
    })
  } catch {}
}

/** Stop a specific sound */
export function stopSound(name) {
  // Stop HTML5 Audio
  const a = audioPool[name]
  if (a) {
    try { a.pause(); a.currentTime = 0 } catch {}
  }
  // Stop Web Audio
  waStop(name)
}

/** Stop all playing sounds */
export function stopAll() {
  Object.keys(audioPool).forEach(name => stopSound(name))
  Object.keys(waNodes).forEach(name => waStop(name))
}

/** Enable/disable sounds */
export function setSoundEnabled(enabled) {
  soundEnabled = enabled
  if (!enabled) stopAll()
  try { localStorage.setItem('outplay_sound', enabled ? '1' : '0') } catch {}
}

export function isSoundEnabled() { return soundEnabled }

export function setMasterVolume(vol) {
  masterVolume = Math.max(0, Math.min(1, vol))
  try { localStorage.setItem('outplay_volume', String(masterVolume)) } catch {}
}

export function initSounds() {
  try {
    const stored = localStorage.getItem('outplay_sound')
    if (stored === '0') soundEnabled = false
    const vol = localStorage.getItem('outplay_volume')
    if (vol) masterVolume = parseFloat(vol) || 1.0
  } catch {}
}

// Kept for compat but no longer needed
export function unlockAudio() {
  try {
    const ctx = getWAContext()
    if (ctx.state === 'suspended') ctx.resume()
  } catch {}
}

// ── Convenience helpers ──

export const sound = {
  correct:   () => playHTML('correct', 0.7),
  incorrect: () => playHTML('incorrect', 0.7),
  victory:   () => playHTML('victory', 0.8),
  defeat:    () => playHTML('defeat', 0.8),
  coin:      () => playHTML('coin', 0.6),
  gameStart: () => playHTML('gameStart', 0.5),

  // Timer uses Web Audio API so it can be stopped mid-play
  timerStart: () => {
    if (!soundEnabled) return
    // Try Web Audio first (stoppable), fallback to HTML5
    waPreload('timer').then(() => {
      if (!waPlay('timer', 0.5)) {
        playHTML('timer', 0.5)
      }
    })
  },
  timerStop: () => stopSound('timer'),
}

export default sound

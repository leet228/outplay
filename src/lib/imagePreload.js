import { GAME_CARD_IMAGE_URLS } from './gameAssets'
import tgStarSrc from '../assets/star/tgstar.png'
// Crypto icons used by the deposit sheet (TON / USDT cards on
// the main view + the detail screens). Tiny SVGs but we eager-
// load them on app start so the first time the user opens the
// deposit sheet there's zero flash-of-empty-icon.
import tonIconSrc       from '../assets/crypto/ton.svg'
import usdtIconSrc      from '../assets/crypto/usdt.svg'
import smallTonSrc      from '../assets/crypto/small_ton.svg'
import smallUsdtSrc     from '../assets/crypto/small_usdt.svg'
import smallTonBadgeSrc from '../assets/crypto/small_ton_for_usdt.svg'

const preloadedUrls = new Set()
const activePreloads = new Map()
const IMAGE_URL_KEYS = ['avatar_url', 'photo_url']
const APP_IMAGE_URLS = [
  tgStarSrc,
  tonIconSrc,
  usdtIconSrc,
  smallTonSrc,
  smallUsdtSrc,
  smallTonBadgeSrc,
]

// Live feed icons — small thumbnails shown on the Home → Slots tab.
// Bundled via Vite glob so adding a new slot icon (e.g. for a future
// game) is just dropping the file into `assets/games/`.
const liveFeedIconRaw = import.meta.glob(
  ['../assets/games/tower_stack.png',
   '../assets/games/block_blast.png',
   '../assets/games/rocket.png',
   '../assets/games/plinko.png',
   '../assets/games/pixel_mine.png',
   '../assets/games/dice.png',
   '../assets/games/magnetic.png',
   '../assets/games/stardew.png'],
  { eager: true, query: '?url', import: 'default' }
)
const LIVE_FEED_ICON_URLS = Object.values(liveFeedIconRaw)

// Stardew card / preview crop sprites — the same tiny pixel PNGs
// the Home card and the slot-preview overlay render. Warmed with
// the rest of the deferred assets so the card never flashes a
// missing crop on first paint.
const stardewCardSpriteRaw = import.meta.glob(
  ['../assets/stardew/symbols/potatoe.png',
   '../assets/stardew/symbols/carrot.png',
   '../assets/stardew/symbols/corn.png',
   '../assets/stardew/symbols/eggplant.png',
   '../assets/stardew/symbols/tomatoe.png',
   '../assets/stardew/symbols/grape.png',
   '../assets/stardew/symbols/pumpkin.png',
   '../assets/stardew/symbols/watermelon.png',
   '../assets/stardew/symbols/lime.png'],
  { eager: true, query: '?url', import: 'default' }
)
const STARDEW_CARD_SPRITE_URLS = Object.values(stardewCardSpriteRaw)

// Pixel Mine textures — reels, blocks, damage frames, chests. ~30
// PNGs the slot needs once the player taps in. We warm them after
// the splash dismisses so the slot mounts with everything cached.
const pixelMineTextureRaw = import.meta.glob(
  '../assets/games/pixel_mine/**/*.png',
  { eager: true, query: '?url', import: 'default' }
)
const PIXEL_MINE_TEXTURE_URLS = Object.values(pixelMineTextureRaw)

function isImageUrl(url) {
  if (typeof url !== 'string') return false
  if (!url || url.length < 8) return false
  return url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/') ||
    url.startsWith('data:image/')
}

function runIdle(task) {
  if (typeof window === 'undefined') return
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(task, { timeout: 2000 })
  } else {
    window.setTimeout(task, 80)
  }
}

export function preloadImage(url) {
  if (typeof window === 'undefined' || typeof Image === 'undefined') return false
  if (!isImageUrl(url) || preloadedUrls.has(url)) return false

  preloadedUrls.add(url)

  const img = new Image()
  activePreloads.set(url, img)
  img.decoding = 'async'
  img.onload = img.onerror = () => {
    activePreloads.delete(url)
    img.onload = null
    img.onerror = null
  }
  img.src = url
  return true
}

export function preloadImages(urls, options = {}) {
  const { idle = true, limit = 120 } = options
  const unique = []
  const seen = new Set()

  for (const url of urls ?? []) {
    if (!isImageUrl(url) || seen.has(url) || preloadedUrls.has(url)) continue
    seen.add(url)
    unique.push(url)
    if (unique.length >= limit) break
  }

  if (unique.length === 0) return 0

  const task = () => unique.forEach(preloadImage)
  if (idle) runIdle(task)
  else task()

  return unique.length
}

function collectImageUrls(value, urls, depth = 0) {
  if (!value || depth > 5) return urls

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 120)) collectImageUrls(item, urls, depth + 1)
    return urls
  }

  if (typeof value !== 'object') return urls

  for (const key of IMAGE_URL_KEYS) {
    if (isImageUrl(value[key])) urls.add(value[key])
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectImageUrls(child, urls, depth + 1)
  }

  return urls
}

export function getStoreImageUrls(state) {
  const urls = new Set()
  const roots = [
    state.user,
    state.friends,
    state.friendRequests,
    state.leaderboard,
    state.guild,
    state.guildMembers,
    state.topGuilds,
    state.recentOpponents,
    state.referrals,
  ]

  for (const root of roots) collectImageUrls(root, urls)
  return [...urls]
}

export function preloadGameCardImages() {
  return preloadImages(GAME_CARD_IMAGE_URLS, { idle: false, limit: GAME_CARD_IMAGE_URLS.length })
}

export function preloadAppImages() {
  return preloadImages(APP_IMAGE_URLS, { idle: false, limit: APP_IMAGE_URLS.length })
}

export function preloadStoreImages(state) {
  return preloadImages(getStoreImageUrls(state), { idle: true, limit: 160 })
}

/**
 * Lazy-warm everything that isn't required for first paint:
 *   - Live feed slot thumbnails (one PNG per slot)
 *   - Stardew card / preview crop sprites (9 PNGs)
 *   - Pixel Mine textures (reels / blocks / damage frames / chests)
 *
 * Caller schedules this after the splash dismisses so the launch
 * critical path stays clean. Each call is idempotent — already-loaded
 * URLs are skipped via the global preloadedUrls set.
 */
export function preloadDeferredAssets() {
  const total = preloadImages(LIVE_FEED_ICON_URLS, {
    idle: true, limit: LIVE_FEED_ICON_URLS.length,
  }) + preloadImages(STARDEW_CARD_SPRITE_URLS, {
    idle: true, limit: STARDEW_CARD_SPRITE_URLS.length,
  }) + preloadImages(PIXEL_MINE_TEXTURE_URLS, {
    idle: true, limit: PIXEL_MINE_TEXTURE_URLS.length,
  })
  return total
}

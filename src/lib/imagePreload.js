import { GAME_CARD_IMAGE_URLS } from './gameAssets'
import tgStarSrc from '../assets/star/tgstar.png'

const preloadedUrls = new Set()
const activePreloads = new Map()
const IMAGE_URL_KEYS = ['avatar_url', 'photo_url']
const APP_IMAGE_URLS = [tgStarSrc]

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

import { useEffect, useState, useRef } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { uploadBugPhoto, submitBugReport } from '../lib/supabase'
import './BugReportSheet.css'

const MAX_PHOTOS = 3
const MIN_CHARS = 10
const MAX_WIDTH = 1200
const JPEG_QUALITY = 0.8

function SuccessCheckmark() {
  return (
    <div className="br-success-circle">
      <svg className="br-success-check" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M12 25L20 33L36 15" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      let { width, height } = img
      if (width > MAX_WIDTH) {
        height = Math.round(height * (MAX_WIDTH / width))
        width = MAX_WIDTH
      }
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        JPEG_QUALITY
      )
    }
    img.onerror = () => resolve(file) // fallback to original
    img.src = URL.createObjectURL(file)
  })
}

export default function BugReportSheet() {
  const { bugReportOpen, setBugReportOpen, lang, user, balance, currency } = useGameStore()
  const t = translations[lang]

  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState([]) // { file, preview, compressed }
  const [status, setStatus] = useState('idle') // idle | loading | success
  const [errorMsg, setErrorMsg] = useState('')
  const fileRef = useRef(null)

  const canSubmit = description.trim().length >= MIN_CHARS && status !== 'loading'

  const close = () => {
    haptic('light')
    setBugReportOpen(false)
  }

  // Reset on close
  useEffect(() => {
    if (!bugReportOpen) {
      setTimeout(() => {
        setDescription('')
        setPhotos([])
        setStatus('idle')
        setErrorMsg('')
      }, 300)
    }
  }, [bugReportOpen])

  // Telegram BackButton
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (bugReportOpen) {
      tg.BackButton.show()
      const handler = () => close()
      tg.BackButton.onClick(handler)
      return () => { tg.BackButton.offClick(handler) }
    } else {
      tg.BackButton.hide()
    }
  }, [bugReportOpen])

  // Auto-close after success
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => setBugReportOpen(false), 2500)
      return () => clearTimeout(timer)
    }
  }, [status])

  async function handleAddPhoto(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    haptic('light')

    const remaining = MAX_PHOTOS - photos.length
    const toAdd = files.slice(0, remaining)

    for (const file of toAdd) {
      const compressed = await compressImage(file)
      const preview = URL.createObjectURL(compressed)
      setPhotos(prev => [...prev, { file: compressed, preview }])
    }

    // Reset input so same file can be selected again
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleRemovePhoto(index) {
    haptic('light')
    setPhotos(prev => {
      const removed = prev[index]
      if (removed?.preview) URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  async function handleSubmit() {
    if (!canSubmit) return
    haptic('medium')
    setStatus('loading')
    setErrorMsg('')

    try {
      // 1. Upload photos
      const photoUrls = []
      for (const photo of photos) {
        const url = await uploadBugPhoto(user.id, photo.file)
        if (url) photoUrls.push(url)
      }

      // 2. Collect context
      const context = {
        balance,
        lang,
        currency: currency?.code,
        telegram_id: user.telegram_id,
        username: user.username || user.first_name,
      }

      // 3. Submit
      await submitBugReport(
        user.id,
        description.trim(),
        photoUrls,
        navigator.userAgent,
        context
      )

      setStatus('success')
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success') } catch {}
    } catch (err) {
      console.error('Bug report error:', err)
      setStatus('idle')
      setErrorMsg(lang === 'ru' ? 'Не удалось отправить' : 'Failed to submit')
    }
  }

  return (
    <>
      <div className={`br-overlay ${bugReportOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`br-sheet ${bugReportOpen ? 'open' : ''}`}>
        <div className="br-handle" />

        {/* Success */}
        {status === 'success' && (
          <div className="br-success">
            <SuccessCheckmark />
            <span className="br-success-title">{t.bugReportSuccess}</span>
            <span className="br-success-sub">{t.bugReportSuccessSub}</span>
          </div>
        )}

        {/* Form */}
        {(status === 'idle' || status === 'loading') && (
          <>
            <div className="br-header">
              <span className="br-title">{t.bugReportTitle}</span>
              <button className="br-close" onClick={close}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="br-body">
              {/* Description */}
              <div className="br-field">
                <label className="br-label">{t.bugReportLabel}</label>
                <textarea
                  className="br-textarea"
                  placeholder={t.bugReportPlaceholder}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={4}
                  maxLength={2000}
                />
                <span className={`br-hint ${description.length > 0 && description.trim().length < MIN_CHARS ? 'br-hint-warn' : ''}`}>
                  {description.trim().length < MIN_CHARS ? t.bugReportMinChars : `${description.trim().length}/2000`}
                </span>
              </div>

              {/* Photos */}
              <div className="br-field">
                <label className="br-label">
                  {t.bugReportPhotos} <span className="br-label-hint">({t.bugReportPhotosHint})</span>
                </label>
                <div className="br-photos-grid">
                  {photos.map((photo, i) => (
                    <div key={i} className="br-photo-thumb">
                      <img src={photo.preview} alt="" />
                      <button className="br-photo-remove" onClick={() => handleRemovePhoto(i)} type="button">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {photos.length < MAX_PHOTOS && (
                    <button className="br-photo-add" onClick={() => fileRef.current?.click()} type="button">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleAddPhoto}
                  style={{ display: 'none' }}
                />
              </div>

              {/* Error */}
              {errorMsg && (
                <span className="br-error">{errorMsg}</span>
              )}

              {/* Submit */}
              <button
                className="br-submit-btn"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {status === 'loading' ? (
                  <div className="br-btn-spinner" />
                ) : (
                  t.bugReportSubmit
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

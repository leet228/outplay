import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { supabase } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import './Duel.css'

const CATEGORIES = [
  { id: 'general', label: '🌍 Общие знания' },
  { id: 'history', label: '📜 История' },
  { id: 'science', label: '🔬 Наука' },
  { id: 'sport', label: '⚽ Спорт' },
  { id: 'movies', label: '🎬 Кино' },
  { id: 'music', label: '🎵 Музыка' },
]

const STAKES = [
  { stars: 50, label: '50 ⭐' },
  { stars: 100, label: '100 ⭐' },
  { stars: 300, label: '300 ⭐' },
  { stars: 500, label: '500 ⭐' },
  { stars: 1000, label: '1000 ⭐' },
]

export default function Duel() {
  const navigate = useNavigate()
  const { user, balance, appSettings } = useGameStore()
  const [tab, setTab] = useState('find') // 'find' | 'create'
  const [category, setCategory] = useState('general')
  const [stake, setStake] = useState(50)
  const [loading, setLoading] = useState(false)

  // Pending duels waiting for opponent
  const [openDuels, setOpenDuels] = useState([])

  async function loadOpenDuels() {
    const { data } = await supabase
      .from('duels')
      .select('*, creator:users!duels_creator_id_fkey(first_name, username)')
      .eq('status', 'waiting')
      .neq('creator_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)
    setOpenDuels(data ?? [])
  }

  async function joinDuel(duel) {
    if (appSettings.game_creation === false) return alert('Игры временно отключены')
    if (balance < duel.stake) return alert('Недостаточно Stars')
    setLoading(true)
    haptic('medium')
    const { error } = await supabase
      .from('duels')
      .update({ opponent_id: user.id, status: 'active' })
      .eq('id', duel.id)

    if (!error) {
      navigate(`/game/${duel.id}`)
    }
    setLoading(false)
  }

  async function createDuel() {
    if (appSettings.game_creation === false) return alert('Игры временно отключены')
    if (balance < stake) return alert('Недостаточно Stars')
    setLoading(true)
    haptic('medium')

    const { data, error } = await supabase
      .from('duels')
      .insert({
        creator_id: user.id,
        category,
        stake,
        status: 'waiting',
      })
      .select()
      .single()

    if (!error && data) {
      navigate(`/game/${data.id}`)
    }
    setLoading(false)
  }

  return (
    <div className="duel page">
      <div className="duel-tabs">
        <button
          className={`tab ${tab === 'find' ? 'active' : ''}`}
          onClick={() => { setTab('find'); loadOpenDuels() }}
        >
          Найти дуэль
        </button>
        <button
          className={`tab ${tab === 'create' ? 'active' : ''}`}
          onClick={() => setTab('create')}
        >
          Создать дуэль
        </button>
      </div>

      {tab === 'find' && (
        <div className="find-section">
          {openDuels.length === 0 ? (
            <div className="empty-state">
              <p>Нет открытых дуэлей</p>
              <button className="btn-primary" onClick={() => setTab('create')}>
                Создать первую ⚔️
              </button>
            </div>
          ) : (
            <div className="duel-list">
              {openDuels.map((d) => (
                <div key={d.id} className="duel-card" onClick={() => joinDuel(d)}>
                  <div className="duel-card-info">
                    <span className="duel-creator">{d.creator?.first_name ?? 'Игрок'}</span>
                    <span className="duel-cat">{CATEGORIES.find(c => c.id === d.category)?.label}</span>
                  </div>
                  <span className="duel-stake">{d.stake} ⭐</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'create' && (
        <div className="create-section">
          <h3>Категория</h3>
          <div className="category-grid">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={`category-btn ${category === c.id ? 'active' : ''}`}
                onClick={() => { setCategory(c.id); haptic('light') }}
              >
                {c.label}
              </button>
            ))}
          </div>

          <h3>Ставка</h3>
          <div className="stake-grid">
            {STAKES.map((s) => (
              <button
                key={s.stars}
                className={`stake-btn ${stake === s.stars ? 'active' : ''}`}
                onClick={() => { setStake(s.stars); haptic('light') }}
                disabled={balance < s.stars}
              >
                {s.label}
              </button>
            ))}
          </div>

          <button
            className="btn-primary"
            onClick={createDuel}
            disabled={loading || balance < stake}
          >
            {loading ? 'Создаём...' : `⚔️ Создать на ${stake} ⭐`}
          </button>

          {balance < stake && (
            <p className="balance-warn">Недостаточно Stars. Баланс: {balance} ⭐</p>
          )}
        </div>
      )}
    </div>
  )
}

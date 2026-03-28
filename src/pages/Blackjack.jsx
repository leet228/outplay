import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import {
  getBlackjackState,
  submitBlackjackAction,
  subscribeBlackjackActions,
  finalizeBlackjack,
  BOT_USER_ID,
  supabase,
  calcPayout,
  heartbeatDuel,
  forfeitDuel,
  claimForfeit,
} from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Blackjack.css'

// ── Card engine ──
const SUITS = ['♠', '♥', '♦', '♣']
const RANKS = ['4','5','6','7','8','9','10','J','Q','K','A']

function cardValue(rank) {
  if (rank === 'A') return 11
  if (['J','Q','K'].includes(rank)) return 10
  return parseInt(rank)
}

function makeCard(rank, suit) {
  return {
    suit, rank,
    value: cardValue(rank),
    color: ['♥','♦'].includes(suit) ? 'red' : 'black',
    id: `${rank}${suit}`,
  }
}

function makeFullDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => makeCard(rank, suit)))
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function calcScore(hand) {
  let sum = 0
  let aces = 0
  for (const c of hand) {
    if (c.rank === 'A') {
      aces++
      sum += 11
    } else {
      sum += c.value
    }
  }
  while (sum > 21 && aces > 0) {
    sum -= 10
    aces--
  }
  return sum
}

function generateDeck16() {
  return shuffle(makeFullDeck()).slice(0, 16)
}

function generateDeck14() {
  return shuffle(makeFullDeck()).slice(0, 14)
}

// ── Pip layouts per rank ──
const PIP_LAYOUTS = {
  'A':  [],
  '2':  [[50,20],[50,80]],
  '3':  [[50,20],[50,50],[50,80]],
  '4':  [[30,20],[70,20],[30,80],[70,80]],
  '5':  [[30,20],[70,20],[50,50],[30,80],[70,80]],
  '6':  [[30,20],[70,20],[30,50],[70,50],[30,80],[70,80]],
  '7':  [[30,20],[70,20],[50,35],[30,50],[70,50],[30,80],[70,80]],
  '8':  [[30,20],[70,20],[50,35],[30,50],[70,50],[50,65],[30,80],[70,80]],
  '9':  [[30,18],[70,18],[30,38],[70,38],[50,50],[30,62],[70,62],[30,82],[70,82]],
  '10': [[30,15],[70,15],[30,33],[70,33],[50,24],[50,50],[30,67],[70,67],[30,85],[70,85]],
}

// ── Card component ──
function Card({ card, faceUp = true, className = '', style }) {
  if (!faceUp) {
    return (
      <div className={`bj-card bj-card--back ${className}`} style={style}>
        <div className="bj-card-back-pattern" />
      </div>
    )
  }
  const isFace = ['J','Q','K'].includes(card.rank)
  const isAce = card.rank === 'A'
  const pips = PIP_LAYOUTS[card.rank] || []

  return (
    <div className={`bj-card bj-card--${card.color} ${className}`} style={style}>
      <span className="bj-card-rank-top">{card.rank}</span>
      <span className="bj-card-suit-top">{card.suit}</span>
      <div className="bj-card-body">
        {(isFace || isAce) ? (
          <span className="bj-card-face-letter">{isAce ? card.suit : card.rank}</span>
        ) : (
          pips.map((pos, i) => (
            <span
              key={i}
              className="bj-card-pip"
              style={{ left: `${pos[0]}%`, top: `${pos[1]}%` }}
            >
              {card.suit}
            </span>
          ))
        )}
      </div>
      <span className="bj-card-rank-bottom">{card.rank}</span>
      <span className="bj-card-suit-bottom">{card.suit}</span>
    </div>
  )
}

// ══════════════════════════════════════════════
//  BOT CARD FAKING SYSTEM
// ══════════════════════════════════════════════

// Choose a natural-looking target score for the bot
function chooseTargetScore(playerScore, botShouldWin, botRealTaken) {
  const takenScore = botRealTaken.reduce((s, c) => s + c.value, 0)

  if (botShouldWin) {
    if (playerScore > 21) {
      // Player bust — bot just needs ≤ 21
      // Pick something reasonable: 15-21
      const minPhantom = 8 // min 2 cards (4+4)
      const target = minPhantom + takenScore + Math.floor(Math.random() * 6) // range
      return Math.min(Math.max(target, takenScore + 8), 21)
    }
    // Bot needs > playerScore and ≤ 21
    const minWin = playerScore + 1
    if (minWin > 21) {
      // Player has 21 — can't beat, return 21 (draw → new round)
      return 21
    }
    // Pick randomly in winning range, but prefer natural scores (17-21)
    const candidates = []
    for (let s = minWin; s <= 21; s++) {
      // Weight: higher scores more likely for natural look
      const weight = s >= 17 ? 3 : 1
      for (let w = 0; w < weight; w++) candidates.push(s)
    }
    return candidates[Math.floor(Math.random() * candidates.length)]
  } else {
    // Bot should lose
    if (playerScore > 21) {
      // Player bust — bot needs to bust worse (higher)
      return playerScore + 1 + Math.floor(Math.random() * 5)
    }
    // Either score less than player, or bust
    const r = Math.random()
    if (r < 0.45 && playerScore > 10) {
      // Lose with a close score (natural looking)
      const minPossible = takenScore + 8 // min phantom sum
      const maxLose = playerScore - 1
      if (minPossible <= maxLose) {
        // Pick from reasonable losing scores
        const lo = Math.max(minPossible, maxLose - 5)
        return lo + Math.floor(Math.random() * (maxLose - lo + 1))
      }
    }
    // Bust — looks natural when bot was "greedy"
    return 22 + Math.floor(Math.random() * 8) // 22-29
  }
}

// Find 2 phantom cards that produce the target score
function findPhantomCards(targetScore, botRealTaken, visibleCardIds) {
  const usedIds = new Set(visibleCardIds)
  botRealTaken.forEach(c => usedIds.add(c.id))

  // Build available cards pool (not in visible set)
  const available = []
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      const id = `${rank}${suit}`
      if (!usedIds.has(id)) {
        available.push(makeCard(rank, suit))
      }
    }
  }

  // Try all pairs to find exact match
  const exactMatches = []
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const testHand = [...botRealTaken, available[i], available[j]]
      const score = calcScore(testHand)
      if (score === targetScore) {
        exactMatches.push([available[i], available[j]])
      }
    }
  }

  if (exactMatches.length > 0) {
    // Pick a random exact match for variety
    return exactMatches[Math.floor(Math.random() * exactMatches.length)]
  }

  // No exact match — find closest
  let bestPair = null
  let bestDiff = Infinity
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const testHand = [...botRealTaken, available[i], available[j]]
      const score = calcScore(testHand)
      const diff = Math.abs(score - targetScore)
      if (diff < bestDiff) {
        bestDiff = diff
        bestPair = [available[i], available[j]]
      }
    }
  }

  return bestPair || [makeCard('7', '♠'), makeCard('8', '♣')] // absolute fallback
}

// Decide how many cards bot takes (human-like variety)
function planBotCardCount() {
  const r = Math.random()
  if (r < 0.30) return 0  // 30% — conservative
  if (r < 0.65) return 1  // 35% — takes one
  if (r < 0.90) return 2  // 25% — takes two
  return 3                 // 10% — aggressive
}

// ── Helpers for server state ──
function deckToCards(bjDeck, indices) {
  return indices.map(i => bjDeck[i])
}

function getRemainingCards(bjDeck, deckIndex) {
  return bjDeck.slice(deckIndex)
}

const TURN_TIME = 10

// ══════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════
export default function Blackjack() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const user = useGameStore(s => s.user)
  const lang = useGameStore(s => s.lang)
  const setLastResult = useGameStore(s => s.setLastResult)
  const t = translations[lang] || translations.ru

  // Mode detection
  const isDevDuel = duelId?.startsWith('dev-')
  const parts = isDevDuel ? duelId.split('-') : []
  const devStake = isDevDuel ? parseInt(parts[2]) || 100 : 0

  // Server duel info
  const [duelInfo, setDuelInfo] = useState(null)
  const isBotGame = isDevDuel || (duelInfo?.is_bot_game ?? false)
  const isPvP = !isDevDuel && duelInfo && !duelInfo.is_bot_game
  const botShouldWinRef = useRef(Math.random() < 0.5)
  const stake = isDevDuel ? devStake : (duelInfo?.stake || 0)
  const isPlayer1 = isDevDuel ? true : (duelInfo?.creator_id === user?.id)
  // Ref for PvP role — set BEFORE calling startRoundFromState to avoid stale closures
  const isPlayer1Ref = useRef(true)

  // Game state
  const [phase, setPhase] = useState('loading')
  const [deck, setDeck] = useState([])
  const [remaining, setRemaining] = useState([])
  const [playerHand, setPlayerHand] = useState([])
  const [opponentHand, setOpponentHand] = useState([])  // what's displayed
  const [playerScore, setPlayerScore] = useState(0)
  const [opponentScore, setOpponentScore] = useState(0)
  const [playerStand, setPlayerStand] = useState(false)
  const [opponentStand, setOpponentStand] = useState(false)
  const [deckSpread, setDeckSpread] = useState(false)
  const [dealStep, setDealStep] = useState(0)
  const [revealOpponent, setRevealOpponent] = useState(false)
  const [result, setResult] = useState(null)
  const [animatingHit, setAnimatingHit] = useState(false)
  const [botTurnTrigger, setBotTurnTrigger] = useState(0)
  const [turnTimer, setTurnTimer] = useState(TURN_TIME)
  const [roundNum, setRoundNum] = useState(1)
  const [drawMessage, setDrawMessage] = useState(false)
  const [isMyTurn, setIsMyTurn] = useState(true)
  const gameOverRef = useRef(false)
  const timerRef = useRef(null)
  const channelRef = useRef(null)
  const actionInFlightRef = useRef(false)
  const deckRef = useRef([])
  const playerStandRef = useRef(false)
  const stakeRef = useRef(0)

  const pvpPollRef = useRef(null)          // PvP polling interval

  // Bot phantom state (only for bot games)
  const botRealTakenRef = useRef([])       // real cards bot took from deck
  const botPlannedHitsRef = useRef(0)      // how many cards bot plans to take
  const botHitsDoneRef = useRef(0)         // how many cards bot has taken
  const allVisibleIdsRef = useRef(new Set()) // IDs of all cards player has seen
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)

  // ── Heartbeat: send every 10s while in game ──
  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev') return
    if (gameOverRef.current) return
    heartbeatDuel(duelId, user.id)
    heartbeatRef.current = setInterval(() => {
      if (!gameOverRef.current) heartbeatDuel(duelId, user.id)
    }, 10000)
    return () => { if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null } }
  }, [duelId, user?.id, isDevDuel])

  // ── Forfeit on app close / background ──
  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev') return
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && !gameOverRef.current && !forfeitedRef.current) {
        forfeitedRef.current = true
        if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null }
        forfeitDuel(duelId, user.id)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [duelId, user?.id, isDevDuel])

  // ── Cleanup ──
  function cleanupChannel() {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
  }

  function cleanupPvpPoll() {
    if (pvpPollRef.current) { clearInterval(pvpPollRef.current); pvpPollRef.current = null }
  }

  useEffect(() => {
    return () => {
      cleanupChannel()
      cleanupPvpPoll()
      clearInterval(timerRef.current)
      gameOverRef.current = false
      playerStandRef.current = false
      sound.timerStop()
    }
  }, [])

  // ── Timer logic ──
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (phase === 'player_turn' && !playerStand && !animatingHit && isMyTurn) {
      setTurnTimer(TURN_TIME)
      timerRef.current = setInterval(() => {
        setTurnTimer(prev => {
          if (prev === 6) sound.timerStart()  // triggers at transition to 5
          if (prev <= 1) {
            clearInterval(timerRef.current)
            timerRef.current = null
            sound.timerStop()
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => {
        clearInterval(timerRef.current)
        timerRef.current = null
        sound.timerStop()
      }
    }
  }, [phase, playerStand, animatingHit, roundNum, isMyTurn])

  // Auto-stand when timer hits 0
  useEffect(() => {
    if (turnTimer === 0 && phase === 'player_turn' && !playerStand && !animatingHit && isMyTurn) {
      handleStandInternal()
    }
  }, [turnTimer])

  // ── PvP polling fallback — detects opponent actions if realtime fails ──
  useEffect(() => {
    if (!isPvP || phase !== 'opponent_turn') { cleanupPvpPoll(); return }

    let pvpPollCount = 0
    pvpPollRef.current = setInterval(async () => {
      pvpPollCount++
      try {
        const data = await getBlackjackState(duelId)
        if (!data) return
        const p1 = isPlayer1Ref.current
        const bjState = data.bj_state
        if (!bjState) return

        // Check if game finished
        if (data.status === 'finished' || bjState.phase === 'finished') {
          cleanupPvpPoll()
          handleFinishedFromServer(bjState)
          return
        }

        // Check if it's now our turn
        const myTurnRole = p1 ? 'player1' : 'player2'
        if (bjState.current_turn === myTurnRole && !playerStandRef.current) {
          cleanupPvpPoll()
          // Refresh full state
          deckRef.current = data.bj_deck
          const oppHandKey = p1 ? 'player2_hand' : 'player1_hand'
          const oppStandKey = p1 ? 'player2_stand' : 'player1_stand'
          const oppCards = deckToCards(data.bj_deck, bjState[oppHandKey])
          setOpponentHand(oppCards)
          setOpponentScore(calcScore(oppCards))
          setRemaining(getRemainingCards(data.bj_deck, bjState.deck_index))
          if (bjState[oppStandKey]) setOpponentStand(true)
          setIsMyTurn(true)
          setPhase('player_turn')
          return
        }

        // Every ~10s, check opponent heartbeat for forfeit
        if (pvpPollCount % 3 === 0 && !forfeitedRef.current) {
          const res = await claimForfeit(duelId, user?.id)
          if (res?.status === 'forfeited') {
            cleanupPvpPoll()
            cleanupChannel()
            if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null }
            gameOverRef.current = true
            const payout = calcPayout(stakeRef.current, user?.is_pro)
            updateLocalStats({ won: true, stake: stakeRef.current, userId: user.id })
            setLastResult({ won: true, myScore: 1, oppScore: 0, total: 1, payout, stake: stakeRef.current, duelId, tiebreak: false, timeDiff: 0, gameType: 'blackjack' })
            navigate('/result')
          }
        }
      } catch (e) {
        console.error('PvP poll error:', e)
      }
    }, 3000)

    return () => cleanupPvpPoll()
  }, [isPvP, phase])

  // ══════════════════════════════════════════
  //  BOT / DEV: Start new round (client-side)
  // ══════════════════════════════════════════

  const startNewRoundBot = useCallback(() => {
    // 14 real cards: 2 player + 12 deck. Bot has 2 phantom cards.
    const d = generateDeck14()
    setDeck(d)
    setRemaining([])
    setPlayerHand([])
    setOpponentHand([])
    setPlayerScore(0)
    setOpponentScore(0)
    setPlayerStand(false)
    setOpponentStand(false)
    setDeckSpread(false)
    setDealStep(0)
    setRevealOpponent(false)
    setResult(null)
    setAnimatingHit(false)
    setBotTurnTrigger(0)
    setTurnTimer(TURN_TIME)
    setIsMyTurn(true)
    gameOverRef.current = false

    // Reset bot phantom state
    botRealTakenRef.current = []
    botPlannedHitsRef.current = planBotCardCount()
    botHitsDoneRef.current = 0

    // Track all visible card IDs
    const visibleIds = new Set()
    d.forEach(c => visibleIds.add(c.id)) // all 14 cards are potentially visible
    allVisibleIdsRef.current = visibleIds

    // Phantom opponent cards — face-down placeholders
    const phantomCard1 = { rank: '?', suit: '?', value: 0, color: 'black', id: 'phantom-1' }
    const phantomCard2 = { rank: '?', suit: '?', value: 0, color: 'black', id: 'phantom-2' }

    // Deal: player gets d[0], d[1]; bot gets 2 phantoms; deck = d[2..13]
    const playerCards = [d[0], d[1]]
    const rem = d.slice(2)

    setPhase('dealing')
    setTimeout(() => { setPlayerHand([playerCards[0]]); setPlayerScore(calcScore([playerCards[0]])); setDealStep(1) }, 600)
    setTimeout(() => { setOpponentHand([phantomCard1]); setDealStep(2) }, 1100)
    setTimeout(() => { setPlayerHand(playerCards); setPlayerScore(calcScore(playerCards)); setDealStep(3) }, 1600)
    setTimeout(() => { setOpponentHand([phantomCard1, phantomCard2]); setDealStep(4) }, 2100)
    setTimeout(() => { setRemaining(rem); setDeckSpread(true) }, 2600)
    setTimeout(() => { setPhase('player_turn') }, 3100)
  }, [])

  // ══════════════════════════════════════════
  //  PVP: Start round from server state
  // ══════════════════════════════════════════

  const startRoundFromState = useCallback((bjDeck, bjState) => {
    // Use ref for role — avoids stale closure from React state timing
    const p1 = isPlayer1Ref.current
    const fullDeck = bjDeck
    deckRef.current = fullDeck
    setDeck(fullDeck)
    setRemaining([])
    setPlayerHand([])
    setOpponentHand([])
    setPlayerScore(0)
    setOpponentScore(0)
    playerStandRef.current = false
    setPlayerStand(false)
    setOpponentStand(false)
    setDeckSpread(false)
    setDealStep(0)
    setRevealOpponent(false)
    setResult(null)
    setAnimatingHit(false)
    setBotTurnTrigger(0)
    setTurnTimer(TURN_TIME)
    gameOverRef.current = false
    setRoundNum(bjState.round || 1)

    const myHandKey = p1 ? 'player1_hand' : 'player2_hand'
    const oppHandKey = p1 ? 'player2_hand' : 'player1_hand'
    const myStandKey = p1 ? 'player1_stand' : 'player2_stand'
    const oppStandKey = p1 ? 'player2_stand' : 'player1_stand'
    const myTurnRole = p1 ? 'player1' : 'player2'

    const myCards = deckToCards(fullDeck, bjState[myHandKey])
    const oppCards = deckToCards(fullDeck, bjState[oppHandKey])
    const rem = getRemainingCards(fullDeck, bjState.deck_index)
    const myStand = bjState[myStandKey]
    const oppStand = bjState[oppStandKey]

    setIsMyTurn(bjState.current_turn === myTurnRole)

    setPhase('dealing')
    setTimeout(() => { setPlayerHand([myCards[0]]); setPlayerScore(calcScore([myCards[0]])); setDealStep(1) }, 600)
    setTimeout(() => { setOpponentHand([oppCards[0]]); setDealStep(2) }, 1100)
    setTimeout(() => {
      if (myCards.length >= 2) { setPlayerHand([myCards[0], myCards[1]]); setPlayerScore(calcScore([myCards[0], myCards[1]])) }
      setDealStep(3)
    }, 1600)
    setTimeout(() => {
      if (oppCards.length >= 2) { setOpponentHand([oppCards[0], oppCards[1]]); setOpponentScore(calcScore([oppCards[0], oppCards[1]])) }
      setDealStep(4)
    }, 2100)
    setTimeout(() => { setRemaining(rem); setDeckSpread(true) }, 2600)
    setTimeout(() => {
      if (myCards.length > 2) { setPlayerHand(myCards); setPlayerScore(calcScore(myCards)) }
      if (oppCards.length > 2) { setOpponentHand(oppCards); setOpponentScore(calcScore(oppCards)) }
      playerStandRef.current = myStand
      setPlayerStand(myStand)
      setOpponentStand(oppStand)
      if (bjState.phase === 'finished') setPhase('finished')
      else if (bjState.current_turn === myTurnRole && !myStand) setPhase('player_turn')
      else setPhase('opponent_turn')
    }, 3100)
  }, [])

  // ── Initialize game ──
  useEffect(() => {
    if (isDevDuel) {
      startNewRoundBot()
      return
    }

    async function loadDuel() {
      // Retry up to 3 times — duel may not be available immediately after creation
      let data = null
      for (let attempt = 0; attempt < 3; attempt++) {
        data = await getBlackjackState(duelId)
        if (data && data.game_type === 'blackjack') break
        data = null
        await new Promise(r => setTimeout(r, 1000))
      }
      if (!data) {
        console.error('Invalid blackjack duel:', duelId)
        navigate('/')
        return
      }
      // Set refs BEFORE anything else — critical for PvP correctness (avoids stale closures)
      isPlayer1Ref.current = data.creator_id === user?.id
      stakeRef.current = data.stake || 0
      setDuelInfo(data)
      botShouldWinRef.current = data.bot_should_win ?? (Math.random() < 0.5)

      if (data.is_bot_game) {
        // Bot game: run client-side with phantom cards
        startNewRoundBot()
      } else {
        // PvP: use server state + realtime
        cleanupChannel()
        channelRef.current = subscribeBlackjackActions(duelId, handleServerAction)
        startRoundFromState(data.bj_deck, data.bj_state)
      }
    }

    loadDuel()
  }, [duelId])

  // ══════════════════════════════════════════
  //  PVP: Realtime handlers
  // ══════════════════════════════════════════

  // Ref-based handler — always uses latest closures (avoids stale subscription callback)
  const serverActionRef = useRef(null)
  serverActionRef.current = function(actionRow) {
    if (actionRow.user_id === user?.id) return
    const { action, card_index, result_state } = actionRow

    if (action === 'draw') { handleDrawFromServer(result_state); return }
    if (action === 'finished') { handleFinishedFromServer(result_state); return }
    if (action === 'hit') animateOpponentHitPvP(card_index, result_state)
    else if (action === 'stand') handleOpponentStandPvP(result_state)
  }

  function handleServerAction(actionRow) {
    serverActionRef.current?.(actionRow)
  }

  function animateOpponentHitPvP(cardIndex, newState) {
    const d = deckRef.current
    if (!d.length) return
    const card = d[cardIndex]
    if (!card) return
    const p1 = isPlayer1Ref.current

    setDeckSpread(false)
    setTimeout(() => {
      setOpponentHand(prev => [...prev, card])
      const oppHandKey = p1 ? 'player2_hand' : 'player1_hand'
      const oppCards = deckToCards(d, newState[oppHandKey])
      setOpponentScore(calcScore(oppCards))
      setRemaining(getRemainingCards(d, newState.deck_index))
      const oppStandKey = p1 ? 'player2_stand' : 'player1_stand'
      if (newState[oppStandKey]) setOpponentStand(true)

      setTimeout(() => {
        setDeckSpread(true)
        const myTurnRole = p1 ? 'player1' : 'player2'
        if (newState.current_turn === myTurnRole && !playerStandRef.current) {
          setIsMyTurn(true)
          setPhase('player_turn')
        } else {
          setIsMyTurn(false)
          setPhase('opponent_turn')
        }
      }, 400)
    }, 500)
  }

  function handleOpponentStandPvP(newState) {
    setOpponentStand(true)
    const p1 = isPlayer1Ref.current
    const myTurnRole = p1 ? 'player1' : 'player2'
    if (newState.current_turn === myTurnRole && !playerStandRef.current) {
      setIsMyTurn(true)
      setPhase('player_turn')
    }
  }

  function handleDrawFromServer(newState) {
    setPhase('finished')
    setRevealOpponent(true)
    setDrawMessage(true)
    haptic('medium')
    setTimeout(async () => {
      setDrawMessage(false)
      const data = await getBlackjackState(duelId)
      if (data) { setDuelInfo(data); startRoundFromState(data.bj_deck, data.bj_state) }
    }, 2500)
  }

  function handleFinishedFromServer(finalState) {
    if (gameOverRef.current) return
    gameOverRef.current = true
    const p1 = isPlayer1Ref.current
    const d = deckRef.current
    setPhase('finished')
    setRevealOpponent(true)
    haptic('heavy')
    const myHandKey = p1 ? 'player1_hand' : 'player2_hand'
    const oppHandKey = p1 ? 'player2_hand' : 'player1_hand'
    const myCards = deckToCards(d, finalState[myHandKey])
    const oppCards = deckToCards(d, finalState[oppHandKey])
    const pScore = calcScore(myCards)
    const oScore = calcScore(oppCards)
    setPlayerHand(myCards); setPlayerScore(pScore)
    setOpponentHand(oppCards); setOpponentScore(oScore)
    navigateToResult(pScore, oScore)
  }

  // ══════════════════════════════════════════
  //  PLAYER HIT
  // ══════════════════════════════════════════

  function handleHit() {
    if (phase !== 'player_turn' || playerStand || animatingHit) return
    if (remaining.length === 0) return
    if (!isMyTurn && isPvP) return
    haptic('light')
    clearInterval(timerRef.current)

    if (isBotGame) handleHitBot()
    else handleHitPvP()
  }

  function handleHitBot() {
    setAnimatingHit(true)
    setDeckSpread(false)

    setTimeout(() => {
      const card = remaining[0]
      const newRemaining = remaining.slice(1)
      const newHand = [...playerHand, card]
      const newScore = calcScore(newHand)

      setPlayerHand(newHand)
      setPlayerScore(newScore)
      setRemaining(newRemaining)

      setTimeout(() => {
        setDeckSpread(true)
        setAnimatingHit(false)

        if (newScore > 21) {
          setPlayerStand(true)
          haptic('medium')
          setTimeout(() => {
            if (!opponentStand) setPhase('opponent_turn')
            else checkBotGameOver(true, true, newScore)
          }, 600)
        }
      }, 400)
    }, 500)
  }

  async function handleHitPvP() {
    if (actionInFlightRef.current) return
    actionInFlightRef.current = true
    setAnimatingHit(true)
    setDeckSpread(false)

    let res = await submitBlackjackAction(duelId, user.id, 'hit')
    // Retry once on failure (network error could mean server got it)
    if (!res || res.error) {
      await new Promise(r => setTimeout(r, 1000))
      res = await submitBlackjackAction(duelId, user.id, 'hit')
    }
    actionInFlightRef.current = false

    if (!res || res.error) {
      console.error('Hit error:', res?.error)
      setAnimatingHit(false); setDeckSpread(true)
      return
    }

    const newState = res.state || res.new_state
    if (!newState) { setAnimatingHit(false); setDeckSpread(true); return }

    const p1 = isPlayer1Ref.current
    const myHandKey = p1 ? 'player1_hand' : 'player2_hand'
    const myStandKey = p1 ? 'player1_stand' : 'player2_stand'
    const myCards = deckToCards(deck, newState[myHandKey])
    const myScore = calcScore(myCards)
    const rem = getRemainingCards(deck, newState.deck_index)
    const myStand = newState[myStandKey]
    const myTurnRole = p1 ? 'player1' : 'player2'

    setTimeout(() => {
      setPlayerHand(myCards); setPlayerScore(myScore); setRemaining(rem)
      setTimeout(() => {
        setDeckSpread(true); setAnimatingHit(false)
        if (myStand) { playerStandRef.current = true; setPlayerStand(true); haptic('medium') }
        if (res.status === 'draw') { handleDrawPvPLocal(res); return }
        if (res.status === 'finished') { handleFinishedPvPLocal(res); return }
        if (newState.current_turn === myTurnRole && !myStand) {
          setIsMyTurn(true); setPhase('player_turn')
        } else {
          setIsMyTurn(false); setPhase('opponent_turn')
        }
      }, 400)
    }, 500)
  }

  // ══════════════════════════════════════════
  //  PLAYER STAND
  // ══════════════════════════════════════════

  function handleStandInternal() {
    if (playerStand) return
    haptic('medium')
    clearInterval(timerRef.current)
    if (isBotGame) handleStandBot()
    else handleStandPvP()
  }

  function handleStandBot() {
    setPlayerStand(true)
    setTimeout(() => {
      if (!opponentStand) setPhase('opponent_turn')
      else checkBotGameOver(true, true, playerScore)
    }, 400)
  }

  async function handleStandPvP() {
    if (actionInFlightRef.current) return
    actionInFlightRef.current = true
    playerStandRef.current = true
    setPlayerStand(true)

    const res = await submitBlackjackAction(duelId, user.id, 'stand')
    actionInFlightRef.current = false

    if (!res || res.error) { console.error('Stand error:', res?.error); return }
    const newState = res.state || res.new_state
    if (res.status === 'draw') { handleDrawPvPLocal(res); return }
    if (res.status === 'finished') { handleFinishedPvPLocal(res); return }
    if (newState) {
      const p1 = isPlayer1Ref.current
      const myTurnRole = p1 ? 'player1' : 'player2'
      if (newState.current_turn === myTurnRole) { setIsMyTurn(true); setPhase('player_turn') }
      else { setIsMyTurn(false); setPhase('opponent_turn') }
    }
  }

  function handleStand() {
    if (phase !== 'player_turn' || playerStand || animatingHit) return
    if (!isMyTurn && isPvP) return
    handleStandInternal()
  }

  function handleDrawPvPLocal(res) {
    setPhase('finished'); setRevealOpponent(true); setDrawMessage(true); haptic('medium')
    setTimeout(async () => {
      setDrawMessage(false)
      if (res.new_state && res.new_deck) {
        deckRef.current = res.new_deck; setDeck(res.new_deck); startRoundFromState(res.new_deck, res.new_state)
      } else {
        const data = await getBlackjackState(duelId)
        if (data) { setDuelInfo(data); startRoundFromState(data.bj_deck, data.bj_state) }
      }
    }, 2500)
  }

  function handleFinishedPvPLocal(res) {
    const p1 = isPlayer1Ref.current
    setPhase('finished'); setRevealOpponent(true); haptic('heavy')
    const pScore = p1 ? res.p1_score : res.p2_score
    const oScore = p1 ? res.p2_score : res.p1_score
    if (res.state) {
      const oppHandKey = p1 ? 'player2_hand' : 'player1_hand'
      setOpponentHand(deckToCards(deck, res.state[oppHandKey]))
    }
    setPlayerScore(pScore); setOpponentScore(oScore)
    navigateToResult(pScore, oScore)
  }

  // ══════════════════════════════════════════
  //  BOT OPPONENT TURN — Natural human-like play
  // ══════════════════════════════════════════

  useEffect(() => {
    if (!isBotGame) return
    if (phase !== 'opponent_turn') return

    if (opponentStand) {
      if (playerStand) checkBotGameOver(true, true, playerScore)
      else setPhase('player_turn')
      return
    }

    const timer = setTimeout(() => {
      const planned = botPlannedHitsRef.current
      const done = botHitsDoneRef.current

      // Bot decides: hit if planned hits remain and cards available
      if (done < planned && remaining.length > 0) {
        // BOT HITS — takes a REAL card from deck (but shows face-down)
        setDeckSpread(false)

        setTimeout(() => {
          const card = remaining[0]
          const newRemaining = remaining.slice(1)

          // Store the real taken card
          botRealTakenRef.current = [...botRealTakenRef.current, card]
          botHitsDoneRef.current = done + 1

          // Display face-down card in opponent hand
          const phantomTaken = {
            rank: '?', suit: '?', value: 0, color: 'black',
            id: `bot-taken-${done}`,
            _realCard: card, // hidden reference for reveal
          }
          setOpponentHand(prev => [...prev, phantomTaken])
          setRemaining(newRemaining)

          setTimeout(() => {
            setDeckSpread(true)

            // Continue: if more hits planned AND player is standing, bot continues
            if (botHitsDoneRef.current < planned && remaining.length > 1) {
              if (playerStand) {
                setTimeout(() => setBotTurnTrigger(n => n + 1), 400)
              } else {
                setTimeout(() => setPhase('player_turn'), 600)
              }
            } else {
              // Done taking cards → bot stands
              setOpponentStand(true)
              if (playerStand) {
                checkBotGameOver(true, true, playerScore)
              } else {
                setTimeout(() => setPhase('player_turn'), 600)
              }
            }
          }, 400)
        }, 500)
      } else {
        // BOT STANDS
        setOpponentStand(true)
        if (playerStand) {
          checkBotGameOver(true, true, playerScore)
        } else {
          setTimeout(() => setPhase('player_turn'), 400)
        }
      }
    }, 1000 + Math.random() * 1500) // 1-2.5s thinking time

    return () => clearTimeout(timer)
  }, [phase, opponentStand, playerStand, botTurnTrigger, isBotGame])

  // ══════════════════════════════════════════
  //  BOT GAME OVER — Fake cards + reveal
  // ══════════════════════════════════════════

  function checkBotGameOver(pStand, oStand, pScore) {
    if (gameOverRef.current) return
    if (!pStand || !oStand) return
    gameOverRef.current = true
    finishBotGame(pScore)
  }

  function finishBotGame(pScore) {
    setPhase('finished')
    haptic('heavy')

    // Gather all visible card IDs (player hand + all deck cards ever shown)
    const visibleIds = [...allVisibleIdsRef.current]
    const botTaken = botRealTakenRef.current
    const shouldWin = botShouldWinRef.current

    // Choose target score — may retry if phantom cards can't achieve it
    let target = chooseTargetScore(pScore, shouldWin, botTaken)
    let phantomCards = findPhantomCards(target, botTaken, visibleIds)
    let finalBotHand = [...phantomCards, ...botTaken]
    let botScore = calcScore(finalBotHand)

    // Verify visual result matches intended outcome
    // If phantom cards couldn't achieve target, the visual score may contradict bot_should_win
    const playerBust = pScore > 21
    const botBust = botScore > 21

    const visualBotWins = botBust ? false : playerBust ? true : botScore > pScore
    const visualDraw = !playerBust && !botBust && botScore === pScore
    const intendedBotWins = shouldWin

    // If visual doesn't match intent (and not a draw), retry with adjusted target
    if (!visualDraw && visualBotWins !== intendedBotWins) {
      // Recalculate with a different target
      if (intendedBotWins) {
        // Bot should win but visual shows loss — give bot higher score
        const newTarget = playerBust ? Math.min(17 + Math.floor(Math.random() * 5), 21) : Math.min(pScore + 1 + Math.floor(Math.random() * (21 - pScore)), 21)
        phantomCards = findPhantomCards(newTarget, botTaken, visibleIds)
      } else {
        // Bot should lose but visual shows win — give bot lower score or bust
        const newTarget = playerBust
          ? pScore + 1 + Math.floor(Math.random() * 5) // bust worse
          : Math.max(2, pScore - 1 - Math.floor(Math.random() * 5)) // score less
        phantomCards = findPhantomCards(newTarget, botTaken, visibleIds)
      }
      finalBotHand = [...phantomCards, ...botTaken]
      botScore = calcScore(finalBotHand)
    }

    // Reveal!
    setOpponentHand(finalBotHand)
    setOpponentScore(botScore)
    setRevealOpponent(true)

    // Final winner from visual score (now guaranteed to match intent in 99% cases)
    const finalBotBust = botScore > 21
    const finalPlayerBust = pScore > 21
    let won
    if (finalBotBust && finalPlayerBust) {
      won = pScore <= botScore // both bust: lower bust wins (or use shouldWin)
    } else if (finalBotBust) {
      won = true
    } else if (finalPlayerBust) {
      won = false
    } else if (botScore === pScore) {
      won = !shouldWin // draw edge case — use intent
    } else {
      won = pScore > botScore
    }

    const payout = won ? calcPayout(stake, user?.is_pro) : 0
    setResult({ won, draw: false, pScore, oScore: botScore, payout })
    if (won) { sound.victory(); sound.coin() } else { sound.defeat() }

    // Finalize on server (if not dev mode) — retry once on failure
    if (!isDevDuel && duelInfo) {
      const creatorScore = pScore
      const opponentFinalScore = botScore
      finalizeBlackjack(duelId, creatorScore, opponentFinalScore).then(fRes => {
        if (!fRes || fRes.error) {
          setTimeout(() => finalizeBlackjack(duelId, creatorScore, opponentFinalScore), 1500)
        }
      })
    }

    // Local stats update (PnL, leaderboard, guild, etc.)
    if (won !== null) updateLocalStatsWrapper(won, stake)

    setTimeout(() => {
      setLastResult({
        won,
        myScore: pScore,
        oppScore: botScore,
        total: 21,
        payout,
        stake,
        duelId,
        tiebreak: false,
        timeDiff: 0,
        gameType: 'blackjack',
      })
      navigate('/result')
    }, 3000)
  }

  // Local PnL/stats update after game — uses shared utility
  function updateLocalStatsWrapper(won, currentStake) {
    if (isDevDuel) return
    updateLocalStats({ won, stake: currentStake, userId: user?.id })
  }

  // ══════════════════════════════════════════
  //  PVP: Navigate to result
  // ══════════════════════════════════════════

  function navigateToResult(pScore, oScore) {
    const playerBust = pScore > 21
    const oppBust = oScore > 21
    let won = null

    if (playerBust && oppBust) {
      won = pScore === oScore ? null : pScore < oScore
    } else if (playerBust) {
      won = false
    } else if (oppBust) {
      won = true
    } else {
      won = pScore === oScore ? null : pScore > oScore
    }

    // Use ref for stake — avoids stale closure in realtime handlers
    const currentStake = stakeRef.current || stake
    const payout = won ? calcPayout(currentStake, user?.is_pro) : 0
    setResult({ won, draw: false, pScore, oScore, payout })
    if (won) { sound.victory(); sound.coin() } else { sound.defeat() }

    // Local stats update (PnL, leaderboard, guild, etc.)
    if (won !== null) updateLocalStatsWrapper(won, currentStake)

    setTimeout(() => {
      setLastResult({
        won,
        myScore: pScore,
        oppScore: oScore,
        total: 21,
        payout,
        stake: currentStake,
        duelId,
        tiebreak: false,
        timeDiff: 0,
        gameType: 'blackjack',
      })
      navigate('/result')
    }, 3000)
  }

  // ══════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════

  if (phase === 'loading') {
    return (
      <div className="bj-loading">
        <div className="bj-loading-spinner" />
      </div>
    )
  }

  const playerBust = playerScore > 21
  const oppBust = opponentScore > 21
  const showTimer = phase === 'player_turn' && !playerStand && !animatingHit && isMyTurn
  const timerUrgent = turnTimer <= 3
  const showActions = phase === 'player_turn' && !playerStand && isMyTurn
  const showWaiting = (phase === 'opponent_turn') ||
    (phase === 'player_turn' && !playerStand && !isMyTurn && isPvP)

  return (
    <div className="bj-table">
      {roundNum > 1 && (
        <div className="bj-round-badge">{t.bjRound || 'Раунд'} {roundNum}</div>
      )}

      {/* Opponent area */}
      <div className="bj-area bj-opponent-area">
        <div className="bj-area-label">{t.bjOpponent || 'Соперник'}</div>
        <div className="bj-hand bj-hand--opp">
          {opponentHand.map((card, i) => (
            <Card
              key={card.id}
              card={card}
              faceUp={revealOpponent && card.rank !== '?'}
              className={`bj-hand-card ${dealStep >= (i === 0 ? 2 : 4) ? 'bj-dealt' : (i >= 2 ? 'bj-dealt' : 'bj-dealing')} ${revealOpponent && card.rank !== '?' ? 'bj-flip' : ''}`}
              style={{ '--i': i }}
            />
          ))}
        </div>
        {revealOpponent && opponentScore > 0 && (
          <div className={`bj-score ${oppBust ? 'bj-score--bust' : ''}`}>
            {opponentScore} {oppBust ? (t.bjBust || 'Перебор!') : (t.bjPoints || 'очков')}
          </div>
        )}
        {!revealOpponent && opponentHand.length > 0 && (
          <div className="bj-score bj-score--hidden">? ?</div>
        )}
      </div>

      {/* Deck area */}
      <div className="bj-deck-area">
        {remaining.length > 0 && (
          <div className={`bj-deck ${deckSpread ? 'bj-deck--spread' : 'bj-deck--stacked'}`}>
            {remaining.map((card, i) => (
              <Card
                key={card.id}
                card={card}
                faceUp={deckSpread}
                className="bj-deck-card"
                style={{
                  '--i': i,
                  '--total': remaining.length,
                  zIndex: remaining.length - i,
                }}
              />
            ))}
          </div>
        )}
        {remaining.length === 0 && phase !== 'loading' && phase !== 'dealing' && (
          <div className="bj-deck-empty">{t.bjDeckEmpty || 'Колода пуста'}</div>
        )}
      </div>

      {/* Player area */}
      <div className="bj-area bj-player-area">
        <div className="bj-hand">
          {playerHand.map((card, i) => (
            <Card
              key={card.id}
              card={card}
              faceUp={true}
              className={`bj-hand-card ${dealStep >= (i === 0 ? 1 : 3) ? 'bj-dealt' : 'bj-dealing'}`}
              style={{ '--i': i }}
            />
          ))}
        </div>
        <div className={`bj-score ${playerBust ? 'bj-score--bust' : ''}`}>
          {playerScore} {playerBust ? (t.bjBust || 'Перебор!') : (t.bjPoints || 'очков')}
        </div>

        {showActions && (
          <div className="bj-actions-wrap">
            {showTimer && (
              <div className={`bj-timer ${timerUrgent ? 'bj-timer--urgent' : ''}`}>
                <svg className="bj-timer-ring" viewBox="0 0 36 36">
                  <circle className="bj-timer-bg" cx="18" cy="18" r="16" />
                  <circle
                    className="bj-timer-progress"
                    cx="18" cy="18" r="16"
                    strokeDasharray={`${(turnTimer / TURN_TIME) * 100.5} 100.5`}
                  />
                </svg>
                <span className="bj-timer-num">{turnTimer}</span>
              </div>
            )}
            <div className="bj-actions">
              <button
                className="bj-btn bj-btn--hit"
                onClick={handleHit}
                disabled={animatingHit || remaining.length === 0}
              >
                {t.bjHit || 'Взять'}
              </button>
              <button
                className="bj-btn bj-btn--stand"
                onClick={handleStand}
                disabled={animatingHit}
              >
                {t.bjStand || 'Хватит'}
              </button>
            </div>
          </div>
        )}

        {showWaiting && (
          <div className="bj-waiting">
            <span className="bj-waiting-dot" />
            <span className="bj-waiting-dot" />
            <span className="bj-waiting-dot" />
            <span className="bj-waiting-text">{t.bjOpponentThinking || 'Соперник думает...'}</span>
          </div>
        )}

        {playerStand && phase !== 'finished' && !showWaiting && (
          <div className="bj-stand-label">{t.bjYouStand || 'Вы остановились'}</div>
        )}

        {phase === 'finished' && result && !result.draw && (
          <div className={`bj-result ${result.won ? 'bj-result--win' : 'bj-result--lose'}`}>
            <span className="bj-result-emoji">{result.won ? '🏆' : '💀'}</span>
            <span className="bj-result-text">
              {result.won ? (t.bjWin || 'Победа!') : (t.bjLose || 'Поражение')}
            </span>
          </div>
        )}
      </div>

      {/* Draw overlay */}
      {drawMessage && (
        <div className="bj-draw-overlay">
          <div className="bj-draw-card">
            <span className="bj-draw-emoji">🤝</span>
            <span className="bj-draw-title">{t.bjDraw || 'Ничья!'}</span>
            <span className="bj-draw-sub">{t.bjDrawSub || 'Новый раунд...'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

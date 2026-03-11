import { create } from 'zustand'
import { syncUserSettings } from '../lib/supabase'

const useGameStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => set({ user }),

  // Balance
  balance: 0,
  setBalance: (balance) => set({ balance }),
  addBalance: (amount) => set((s) => ({ balance: s.balance + amount })),

  // Currency
  currency: JSON.parse(localStorage.getItem('outplay_currency')) || { symbol: '₽', code: 'RUB' },
  setCurrency: (currency) => {
    localStorage.setItem('outplay_currency', JSON.stringify(currency))
    set({ currency })
    const uid = get().user?.id
    if (uid && uid !== 'dev') syncUserSettings(uid, { currency: currency.code })
  },

  // Language
  lang: localStorage.getItem('outplay_lang') || 'ru',
  setLang: (lang) => {
    localStorage.setItem('outplay_lang', lang)
    set({ lang })
    const uid = get().user?.id
    if (uid && uid !== 'dev') syncUserSettings(uid, { lang })
  },

  // Profile (fetched at bootstrap)
  rank: null,
  setRank: (rank) => set({ rank }),
  dailyStats: [],
  setDailyStats: (dailyStats) => set({ dailyStats }),
  totalPnl: 0,
  setTotalPnl: (totalPnl) => set({ totalPnl }),

  // Shop — plans (fetched at bootstrap, cached)
  plans: [],
  setPlans: (plans) => set({ plans }),

  // Shop — referral earnings by period (fetched at bootstrap via get_user_profile)
  refEarnings: null,
  setRefEarnings: (refEarnings) => set({ refEarnings }),

  // Shop — referrals list (lazy loaded on first Shop visit, null = not loaded yet)
  referrals: null,         // { total, items } | null
  referralsLoading: false,
  setReferrals: (referrals) => set({ referrals }),
  setReferralsLoading: (v) => set({ referralsLoading: v }),

  // Active duel
  activeDuel: null,
  setActiveDuel: (duel) => set({ activeDuel: duel }),
  clearDuel: () => set({ activeDuel: null }),

  // Game session (current question set)
  questions: [],
  currentIndex: 0,
  answers: [],
  setQuestions: (questions) => set({ questions, currentIndex: 0, answers: [] }),
  answerQuestion: (answerIndex) => {
    const { currentIndex, answers, questions } = get()
    const question = questions[currentIndex]
    const isCorrect = answerIndex === question.correct_index
    set({
      answers: [...answers, { questionId: question.id, answerIndex, isCorrect }],
      currentIndex: currentIndex + 1,
    })
    return isCorrect
  },
  resetGame: () => set({ questions: [], currentIndex: 0, answers: [] }),

  // Result
  lastResult: null,
  setLastResult: (result) => set({ lastResult: result }),

  // Deposit sheet
  depositOpen: false,
  setDepositOpen: (v) => set({ depositOpen: v }),
}))

export default useGameStore

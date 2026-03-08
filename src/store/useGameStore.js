import { create } from 'zustand'

const useGameStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => set({ user }),

  // Balance
  balance: 0,
  setBalance: (balance) => set({ balance }),
  addBalance: (amount) => set((s) => ({ balance: s.balance + amount })),

  // Currency
  currency: { symbol: '₽', code: 'RUB' },
  setCurrency: (currency) => set({ currency }),

  // Language
  lang: 'ru',
  setLang: (lang) => set({ lang }),

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

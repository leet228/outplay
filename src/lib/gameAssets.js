import blackjackCardArt from '../assets/games/blackjack-card.jpg'
import capitalsCardArt from '../assets/games/capitals-card.jpg'
import circleCardArt from '../assets/games/circle-card.jpg'
import gradientCardArt from '../assets/games/gradient-card.jpg'
import hearingCardArt from '../assets/games/hearing-card.jpg'
import quizCardArt from '../assets/games/quiz-card.jpg'
import reactionCardArt from '../assets/games/reaction-card.jpg'
import sequenceCardArt from '../assets/games/sequence-card.jpg'

export const GAME_CARD_ART = {
  quiz: quizCardArt,
  sequence: sequenceCardArt,
  blackjack: blackjackCardArt,
  reaction: reactionCardArt,
  hearing: hearingCardArt,
  gradient: gradientCardArt,
  capitals: capitalsCardArt,
  circle: circleCardArt,
}

export const GAME_CARD_IMAGE_URLS = Object.values(GAME_CARD_ART)

/**
 * "Type your answer" capture.
 *
 * A Feishu card can only carry option buttons; a free-form answer has to arrive
 * as a chat message. When the operator taps 「输入你的答案」 this store records
 * which pending question that chat is answering, so the inbound router can route
 * the *next* message into the question instead of the session.
 *
 * The capture is deliberately short-lived and single-use: one message, one
 * question, then the chat returns to normal routing.
 */

/** @typedef {{ cardId: string, questionId: string, expiresAt: number, askedAt: number }} Capture */

/** How long an expired capture keeps explaining itself to the next message. */
const EXPIRED_TTL_MS = 30 * 60 * 1000

export function createCaptureStore() {
  /** @type {Map<string, Capture>} */
  const byChat = new Map()
  /** chatId → when a capture expired, so the next message can say so once. */
  const expired = new Map()

  function live(entry) {
    return entry !== undefined && Date.now() <= entry.expiresAt
  }

  return {
    /** Arm capture for one chat. Replaces any previous capture. */
    arm(chatId, entry) {
      byChat.set(String(chatId), { askedAt: Date.now(), ...entry })
    },

    /** Read without consuming; an expired entry is dropped and remembered. */
    peek(chatId) {
      const key = String(chatId)
      const entry = byChat.get(key)
      if (entry === undefined) return undefined
      if (!live(entry)) {
        byChat.delete(key)
        expired.set(key, Date.now())
        return undefined
      }
      return entry
    },

    /**
     * Whether a capture just expired for this chat. Consumes the marker: the
     * switch-back notice is sent once, not on every later message.
     */
    takeExpired(chatId) {
      const key = String(chatId)
      const at = expired.get(key)
      if (at === undefined) return false
      expired.delete(key)
      return Date.now() - at <= EXPIRED_TTL_MS
    },

    /** Consume the capture for one chat. */
    take(chatId) {
      const key = String(chatId)
      const entry = byChat.get(key)
      byChat.delete(key)
      if (entry === undefined) return undefined
      if (!live(entry)) {
        expired.set(key, Date.now())
        return undefined
      }
      return { ...entry, consumedAt: Date.now() }
    },

    /** Drop whatever capture belongs to a card (timeout / card retired). */
    dropByCard(cardId) {
      for (const [chatId, entry] of byChat) {
        if (entry.cardId === cardId) {
          byChat.delete(chatId)
          return { chatId, ...entry }
        }
      }
      return undefined
    },

    /** Whether any chat currently holds a capture (diagnostics only). */
    size() {
      return byChat.size
    },
  }
}

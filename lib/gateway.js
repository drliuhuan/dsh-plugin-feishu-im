/**
 * Feishu long connection lifecycle.
 *
 * One WebSocket client per plugin activation: the SDK owns reconnection, while
 * this module owns start/stop when the credentials change (reconnect, manual
 * entry, disconnect). Nothing here touches message semantics — inbound.js does.
 */
export function createGateway({ inbound, cardAction, log, trace }) {
  /** @type {{ key: string, client: any } | null} */
  let running = null
  let pendingStart = null

  function keyOf(state) {
    return `${state.domain}:${state.appId}:${state.appSecret}`
  }

  async function stop() {
    const current = running
    running = null
    if (!current) return
    try {
      // force: the SDK otherwise waits up to 30s for a graceful handshake, and a
      // credential change must not leave the old app connected in the meantime.
      await current.client.close({ force: true })
      trace?.('gateway-stopped', {})
    } catch (error) {
      trace?.('gateway-stop-failed', { message: String((error && error.message) || error) })
    }
  }

  async function start(state) {
    const sdk = await import('@larksuiteoapi/node-sdk')
    const dispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => inbound.handle(data),
      'card.action.trigger': (data) => cardAction?.(data),
    })

    const client = new sdk.WSClient({
      appId: state.appId,
      appSecret: state.appSecret,
      domain: state.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
      loggerLevel: sdk.LoggerLevel.warn,
      onReady: () => trace?.('gateway-ready', {}),
      onError: (error) => trace?.('gateway-error', { message: String((error && error.message) || error) }),
      onReconnecting: () => trace?.('gateway-reconnecting', {}),
    })

    trace?.('gateway-connecting', { domain: state.domain })
    await client.start({ eventDispatcher: dispatcher })
    running = { key: keyOf(state), client }
    trace?.('gateway-started', { domain: state.domain })
  }

  /** Make the live connection match the given state. */
  async function ensure(state) {
    if (!state.appId || !state.appSecret) {
      await stop()
      return
    }
    if (running && running.key === keyOf(state)) return
    if (pendingStart === keyOf(state)) return pendingStart
    pendingStart = (async () => {
      try {
        await stop()
        await start(state)
      } catch (error) {
        const message = String((error && error.message) || error)
        log(`[feishu-im] long connection failed: ${message}`)
        trace?.('gateway-failed', { message: message.slice(0, 300) })
        // A failed start must not be cached as "running": the next state change
        // (or the next draft save) retries.
        running = null
        throw error
      } finally {
        pendingStart = null
      }
    })()
    return pendingStart
  }

  return { ensure, stop }
}

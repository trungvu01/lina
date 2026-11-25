/**
 * PAM MP4 V12 — same-origin, same-browser-profile tab event transport.
 * Does not transport video, cookies, tokens, URLs or credentials. Each receiver
 * MUST verify job authorization with Core status endpoint before showing data.
 * BroadcastChannel is best-effort; Core remains the only job/cache authority.
 */
const CHANNEL = 'pam-replay-mp4-ui-v12'
const instance = (() => {
  try { return crypto.randomUUID() } catch (_) { return `${Date.now()}-${Math.random()}` }
})()
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel(CHANNEL) : null
const listeners = new Set()
const guid = /^[0-9a-f-]{36}$/i

export function publishPamMp4(event) {
  if (!channel) return
  if (event.kind !== 'hello' && (!guid.test(event.sessionId || '') || !guid.test(event.jobId || ''))) return
  const message = { ...event, version: 12, from: instance, at: Date.now() }
  try { channel.postMessage(message) } catch (_) { /* UI sync is optional */ }
}
export function subscribePamMp4(callback) {
  if (!channel) return () => {}
  listeners.add(callback)
  publishPamMp4({ kind: 'hello' })
  return () => listeners.delete(callback)
}
if (channel) channel.onmessage = ({ data: msg }) => {
  if (!msg || msg.version !== 12 || msg.from === instance ||
      !Number.isFinite(msg.at) || Math.abs(Date.now() - msg.at) > 30000 ||
      !['hello', 'state'].includes(msg.kind)) return
  if (msg.kind === 'state' && (!guid.test(msg.sessionId || '') || !guid.test(msg.jobId || '') ||
      !['processing', 'ready', 'cancelled', 'failed'].includes(msg.status))) return
  for (const listener of listeners) {
    try { listener(msg) } catch (_) { /* never break other tab listeners */ }
  }
}

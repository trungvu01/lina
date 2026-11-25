// On-demand SSH/RDP -> MP4. One active browser download at a time.
// Closing/reloading the page cancels the current export where possible; the
// server's polling lease handles unexpected browser termination.
import { defineComponent, h, reactive , TransitionGroup, render, markRaw } from 'vue'
import request from '@/utils/request'
import { addBasePath, download } from '@/utils/common/index'
import { ElMessage } from 'element-plus'
import i18n from '@/i18n/i18n'
import './replayMp4.css'
import { publishPamMp4, subscribePamMp4 } from './pamMp4Sync'

const POLL_INTERVAL_MS = 5000
const MAX_WAIT_MS = 2.5 * 60 * 60 * 1000
const SUCCESS_DURATION_MS = 5000
// Element Plus adds a 16px gap. offset=40 yields actual top=56px.
const TOAST_OFFSET = 40
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
const activeJobs = new Map()
let activeDownload = null // shared across list, detail and all download buttons in this tab

// PAM_MP4_V7 - managed notifications, 429 recovery, hover-aware dismissal.
const MAX_REPLAY_TOASTS = 3
const replayNotices = reactive([])
const recentReplayClicks = new Map()
let exportThrottleUntil = 0
let lastThrottleToast = 0

function replayHttpStatus(error) {
  return Number(error?.response?.status || error?.status || 0)
}
function replayRetryAfter(error) {
  const h = error?.response?.headers
  const text = h?.get?.('retry-after') || h?.['retry-after'] || h?.['Retry-After'] || ''
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric >= 0 && text !== '') return Math.max(1, Math.ceil(numeric))
  const date = Date.parse(String(text))
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000))
  const wait = Number(error?.response?.data?.wait)
  return Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 60
}
// PAM_MP4_V8: one Vue-managed stack, no competing Element Plus offset manager.
// The wrapper stays exactly 56px below the viewport top; TransitionGroup
// animates remaining notices upward and the oldest notice sliding right.
const REPLAY_TOAST_EXIT_MS = 280
const queuedReplayNotices = []
let replayToastRoot = null
let replayToastSequence = 0
let replayToastPump = null

function trackedEntry(handle) {
  return replayNotices.find(entry => entry.handle === handle) ||
    queuedReplayNotices.find(entry => entry.handle === handle)
}

const ReplayToastHost = defineComponent({
  name: 'PamReplayToastHost',
  setup() {
    return () => h(TransitionGroup, {
      name: 'pam-replay-stack', tag: 'div', class: 'pam-replay-stack-items'
    }, {
      default: () => replayNotices.map(entry => h('section', {
        key: entry.id,
        class: ['pam-mp4-notification', entry.options.customClass],
        role: 'status',
        onMouseenter: () => hoverToast(entry.handle, true),
        onMouseleave: () => hoverToast(entry.handle, false)
      }, [
        entry.options.message,
        entry.options.showClose !== false ? h('button', {
          type: 'button', class: 'pam-replay-notice-close',
          'aria-label': copy('Đóng thông báo', 'Dismiss notification'),
          onClick: () => closeTrackedNotice(entry)
        }, '×') : null
      ]))
    })
  }
})

function ensureReplayToastHost() {
  if (replayToastRoot || typeof document === 'undefined') return
  replayToastRoot = document.createElement('div')
  replayToastRoot.id = 'pam-replay-toast-host'
  document.body.appendChild(replayToastRoot)
  render(h(ReplayToastHost), replayToastRoot)
}

function closeTrackedNotice(entry, suppressPump = false) {
  if (!entry || entry.closed) return
  entry.closed = true
  if (entry.timer) window.clearTimeout(entry.timer)
  entry.timer = null
  const activeIndex = replayNotices.indexOf(entry)
  if (activeIndex >= 0) replayNotices.splice(activeIndex, 1)
  const queuedIndex = queuedReplayNotices.indexOf(entry)
  if (queuedIndex >= 0) queuedReplayNotices.splice(queuedIndex, 1)
  entry.options.onClose?.()
  if (!suppressPump) pumpReplayNotices()
}

function evictionCandidate() {
  // Preserve the active conversion (with Cancel), then respect hover when
  // possible. We only evict active/hovered items if all three are protected.
  const others = replayNotices.filter(entry => !entry.closed)
  return others.find(entry => entry.autoHide && !entry.hovered) ||
    others.find(entry => entry.autoHide) ||
    others.find(entry => !entry.hovered) || others[0]
}

function pumpReplayNotices() {
  if (replayToastPump || !queuedReplayNotices.length) return
  const needsEviction = replayNotices.length >= MAX_REPLAY_TOASTS
  if (needsEviction) closeTrackedNotice(evictionCandidate(), true)
  // Complete the old toast's slide-out first, then reveal the new toast.
  replayToastPump = window.setTimeout(() => {
    replayToastPump = null
    while (queuedReplayNotices.length && queuedReplayNotices[0].closed) queuedReplayNotices.shift()
    if (queuedReplayNotices.length) {
      if (replayNotices.length >= MAX_REPLAY_TOASTS) closeTrackedNotice(evictionCandidate(), true)
      const next = queuedReplayNotices.shift()
      if (next && !next.closed) {
        next.shown = true
        replayNotices.push(next)
        if (next.autoHide && !next.hovered) armToastDismiss(next.handle)
      }
    }
    if (queuedReplayNotices.length) pumpReplayNotices()
  }, needsEviction ? REPLAY_TOAST_EXIT_MS : 0)
}

function manageReplayNotice(options) {
  ensureReplayToastHost()
  const entry = markRaw({
    id: ++replayToastSequence, options: { ...options, message: markRaw(options.message) },
    timer: null, hovered: false, autoHide: false, shown: false, closed: false,
    handle: null
  })
  entry.handle = { close: () => closeTrackedNotice(entry) }
  if (replayNotices.length < MAX_REPLAY_TOASTS && queuedReplayNotices.length === 0 && !replayToastPump) {
    entry.shown = true
    replayNotices.push(entry)
  } else {
    queuedReplayNotices.push(entry)
    pumpReplayNotices()
  }
  return entry.handle
}

function armToastDismiss(handle, waitMs = SUCCESS_DURATION_MS) {
  const entry = trackedEntry(handle)
  if (!entry || entry.closed) return
  entry.autoHide = true
  if (entry.timer) window.clearTimeout(entry.timer)
  entry.timer = null
  if (entry.shown && !entry.hovered) {
    entry.timer = window.setTimeout(() => closeTrackedNotice(entry), waitMs)
  }
}

function hoverToast(handle, hovered) {
  const entry = trackedEntry(handle)
  if (!entry || entry.closed || entry.hovered === hovered) return
  entry.hovered = hovered
  if (entry.timer) window.clearTimeout(entry.timer)
  entry.timer = null
  // Fresh five-second countdown starts only after the mouse leaves.
  if (!hovered && entry.autoHide) armToastDismiss(handle)
}

function showReplayRateLimit(row, seconds) {
  if (Date.now() - lastThrottleToast < 1200) return
  lastThrottleToast = Date.now()
  const remaining = Math.max(1, Math.ceil(seconds))
  const title = copy('Tạm giới hạn yêu cầu tải', 'Download rate limit reached')
  const message = copy(`PAM đang giới hạn request. Thử lại sau khoảng ${remaining} giây.`,
    `PAM is limiting requests. Try again in about ${remaining} seconds.`)
  let notice
  notice = manageReplayNotice({
    title: '', duration: 0, showClose: true, offset: TOAST_OFFSET,
    customClass: 'pam-mp4-notification pam-mp4-notification--throttled',
    message: h('div', { class: 'pam-mp4-toast pam-mp4-toast--throttled', role: 'alert',

    }, [
      h('div', { class: 'pam-mp4-toast-header' }, [
        h('span', { class: 'pam-mp4-toast-icon', 'aria-hidden': 'true' }, '!'),
        h('div', { class: 'pam-mp4-toast-heading' }, [
          h('strong', { class: 'pam-mp4-toast-title' }, title),
          h('p', { class: 'pam-mp4-toast-copy' }, message)
        ])
      ]),
      h('p', { class: 'pam-mp4-record-label' }, replayDisplayName(row))
    ])
  })
  armToastDismiss(notice)
}
function setReplayThrottle(error, row) {
  const seconds = replayRetryAfter(error)
  exportThrottleUntil = Math.max(exportThrottleUntil, Date.now() + seconds * 1000)
  showReplayRateLimit(row, seconds)
}
// Only safe, idempotent status GET calls are retried after HTTP 429.
// The POST create operation is NEVER automatically repeated.
async function fetchReplayStatus(options, state, deadline) {
  for (;;) {
    try {
      return await request(options)
    } catch (error) {
      if (replayHttpStatus(error) !== 429 || Date.now() >= deadline) throw error
      state.stage = 'rate_limited'
      const waitMs = Math.min(replayRetryAfter(error) * 1000, Math.max(0, deadline - Date.now()))
      if (!waitMs) throw error
      await sleep(waitMs)
    }
  }
}


function isVietnamese() {
  const locale = i18n?.global?.locale
  const value = typeof locale === 'string' ? locale : (locale?.value || i18n?.locale || '')
  return /^vi/i.test(value)
}
const copy = (vi, en) => isVietnamese() ? vi : en

function nameInParens(value) {
  const s = String(value || '').trim()
  const match = s.match(/^[^()]+\(([^()]*)\)$/)
  return (match?.[1]?.trim() || s || 'unknown')
}
function cleanPiece(value) {
  return String(value || 'unknown').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-')
    .replace(/\s+/g, '-').replace(/_+/g, '-').replace(/-+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 72) || 'unknown'
}
function displayDate(row) {
  const value = row?.date_start ?? row?.date_start_display ?? row?.start_date ??
    row?.dateStart ?? row?.start_time ?? row?.date_created ?? ''
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (match) return `${match[1].slice(2)}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`
  const numeric = Number(raw)
  const parsed = raw && Number.isFinite(numeric)
    ? new Date(numeric < 1e11 ? numeric * 1000 : numeric) : new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${String(parsed.getFullYear()).slice(2)}${pad(parsed.getMonth() + 1)}` +
      `${pad(parsed.getDate())}-${pad(parsed.getHours())}${pad(parsed.getMinutes())}${pad(parsed.getSeconds())}`
  }
  return 'unknown-date'
}
// For UI identification only. The server derives the actual MP4 filename from
// the authenticated Session database record, not from browser-supplied metadata.
export function replayDisplayName(row) {
  return [
    cleanPiece(nameInParens(row?.user)),
    cleanPiece(row?.asset).replace(/\(([^()]*)\)/g, (_, ip) => `(${ip})`),
    cleanPiece(nameInParens(row?.account)),
    cleanPiece(row?.protocol),
    displayDate(row)
  ].join('_')
}

// V12: use the same smooth, bounded, explicitly estimated progress for
// SSH and RDP. Real milestones still come only from Core worker status.
function rdpEstimatedTarget(stage, current, total, elapsedSeconds) {
  if (stage === 'cancelling') return null
  if (stage === 'finalizing') return 98
  if (!total || stage === 'queued') return 0
  const totalSteps = Math.max(1, Number(total) || 1)
  const done = Math.min(totalSteps, Math.max(0, Number(current) || 0))
  const floor = done / totalSteps * 95
  if (done >= totalSteps) return 95
  const ceiling = Math.max(floor, (done + 1) / totalSteps * 95 - 1)
  const age = Math.max(0, Number(elapsedSeconds) || 0)
  return Math.min(95, floor + (ceiling - floor) * (1 - Math.exp(-age / 55)))
}

function percentFor(stage, current, total) {
  if (stage === 'finalizing') return 98
  if (total > 0) return Math.min(95, Math.max(0, Math.floor(current * 95 / total)))
  return stage === 'loading' ? 1 : 0
}
const stages = {
  queued: ['Đang xếp hàng', 'Queued'],
  rate_limited: ['Đang chờ giới hạn API', 'Waiting for API rate limit'],
  loading: ['Đang đọc bản ghi', 'Reading recording'],
  rendering: ['Đang dựng video', 'Rendering video'],
  encoding: ['Đang mã hóa', 'Encoding video'],
  finalizing: ['Đang hoàn tất', 'Finalizing video'],
  cancelling: ['Đang hủy chuyển đổi', 'Cancelling conversion']
}

const ReplayNotice = defineComponent({
  name: 'PamMp4Notice',
  props: { state: { type: Object, required: true } },
  setup(props) {
    return () => {
      const state = props.state
      const success = state.status === 'success'
      const cancelled = state.status === 'cancelled'
      const failed = state.status === 'failed'
      const complete = success || cancelled || failed
      const original = state.kind === 'original'
      const phase = success ? copy('Hoàn tất', 'Complete') : copy(...(stages[state.stage] || stages.queued))
      // Number of parts is intentionally not shown for either protocol.
      const percent = success ? 100 : Math.floor(state.visualPercent || 0)
      return h('div', { class: [
        'pam-mp4-toast', failed ? 'pam-mp4-toast--error' : complete ? `pam-mp4-toast--${state.status}` : 'pam-mp4-toast--processing'
      ], role: 'status', 'aria-live': 'polite' }, [
        h('div', { class: 'pam-mp4-toast-header' }, [
          h('span', { class: 'pam-mp4-toast-icon', 'aria-hidden': 'true' }, success ? '✓' : cancelled ? '✓' : failed ? '!' : 'i'),
          h('div', { class: 'pam-mp4-toast-heading' }, [
            h('strong', { class: 'pam-mp4-toast-title' }, original
              ? (success ? copy('Đã yêu cầu tải bản ghi', 'Recording download requested')
                : copy('Đang mở bản tải', 'Starting download'))
              : (cancelled ? copy('Đã hủy chuyển đổi MP4', 'MP4 conversion cancelled')
                : failed ? copy('Tạo MP4 thất bại', 'MP4 conversion failed')
                : success ? copy('Video MP4 đã sẵn sàng', 'MP4 video is ready')
                : copy('Đang chuẩn bị MP4', 'Preparing MP4 video'))),
            h('p', { class: 'pam-mp4-toast-copy' }, original
              ? copy('Kiểm tra trình duyệt để lưu file.', 'Check your browser download.')
              : (cancelled ? copy('Đã dừng xử lý. Recording gốc được giữ nguyên.', 'Conversion stopped. Original recording was not changed.')
                : failed ? copy('Không thể hoàn tất chuyển đổi.', 'Could not complete the conversion.')
                : success ? (state.mirrored
                  ? copy('MP4 đã sẵn sàng tại tab bắt đầu tải.', 'MP4 is ready in the initiating tab.')
                  : copy('Trình duyệt đang bắt đầu tải.', 'Browser download is starting.'))
                : copy('Bạn có thể tiếp tục sử dụng PAM Web.', 'You can continue using PAM Web.')))

          ]),
          ...(complete ? [h('button', { class: 'pam-mp4-close', type: 'button',
            'aria-label': copy('Đóng', 'Dismiss'), onClick: () => state.dismiss?.() }, '×')] : [])
        ]),
        h('p', { class: 'pam-mp4-record-label', title: state.record || '' }, state.record || ''),
        ...(!original && !complete ? [
          h('div', { class: 'pam-mp4-progress-info' }, [
            h('span', {}, phase + (!state.cancelling ? ` · ${copy('ước tính', 'estimated')}` : '')),
            h('strong', { class: 'pam-mp4-progress-number' }, `${percent}%`)
          ]),
          h('div', { class: 'pam-mp4-track', role: 'progressbar',
            'aria-label': copy('Tiến độ MP4', 'MP4 conversion progress'),
            'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }, [
            h('div', { class: 'pam-mp4-fill', style: { width: `${percent}%` } })
          ]),
          ...(!complete ? [h('button', {
            class: 'pam-mp4-cancel', type: 'button', disabled: state.cancelling,
            onClick: () => state.cancel?.()
          }, state.cancelling ? copy('Đang hủy…', 'Cancelling…') : copy('Hủy chuyển đổi', 'Cancel conversion'))] : [])
        ] : [])
      ])
    }
  }
})

const ERROR_REASONS = {
  processing_timeout: ['Đã vượt thời gian xử lý.', 'Conversion timed out.'],
  duration_limit: ['Phiên quá dài để xử lý.', 'Recording is too long.'],
  resource_limit: ['Máy chủ thiếu tài nguyên xử lý.', 'Insufficient conversion resources.'],
  renderer_failed: ['Không thể dựng video từ bản ghi.', 'Cannot render the recording.'],
  encoder_failed: ['Không thể mã hóa MP4.', 'Cannot encode MP4.'],
  incomplete_video: ['Video không vượt qua kiểm tra toàn vẹn.', 'Video failed integrity check.'],
  duration_mismatch: ['Thời gian phát lại không hợp lệ.', 'Invalid playback timeline.'],
  invalid_recording: ['Bản ghi không hợp lệ.', 'Invalid recording.'],
  missing_part: ['Thiếu một phần của recording RDP.', 'An RDP recording part is missing.'],
  invalid_timeline: ['Timeline recording RDP không hợp lệ.', 'Invalid RDP recording timeline.'],
  unsupported_format: ['Định dạng chưa được hỗ trợ.', 'Unsupported recording format.'],
  unsupported_size: ['Kích thước terminal chưa hỗ trợ.', 'Unsupported terminal dimensions.'],
  not_available: ['Không tìm thấy bản ghi gốc.', 'Original recording unavailable.'],
  converter_missing: ['Máy chủ thiếu công cụ chuyển đổi.', 'Converter unavailable.'],
  unexpected_error: ['Không thể chuẩn bị video.', 'Unable to prepare video.']
}

function showError(row, code, retry = () => downloadReplayMp4(row)) {
  const reason = ERROR_REASONS[code] || ERROR_REASONS.unexpected_error
  let notice
  notice = manageReplayNotice({ title: '', duration: 0, showClose: true, offset: TOAST_OFFSET,
    customClass: 'pam-mp4-notification pam-mp4-notification--error',
    message: h('div', { class: 'pam-mp4-toast pam-mp4-toast--error', role: 'alert' }, [
      h('div', { class: 'pam-mp4-toast-header' }, [
        h('span', { class: 'pam-mp4-toast-icon', 'aria-hidden': 'true' }, '!'),
        h('div', { class: 'pam-mp4-toast-heading' }, [
          h('strong', { class: 'pam-mp4-toast-title' }, copy('Tạo MP4 thất bại', 'MP4 conversion failed')),
          h('p', { class: 'pam-mp4-toast-copy' }, copy(...reason))
        ])
      ]),
      h('p', { class: 'pam-mp4-record-label', title: replayDisplayName(row) }, replayDisplayName(row)),
      h('button', { class: 'pam-mp4-retry', type: 'button', onClick: () => {
        notice?.close()
        window.setTimeout(() => Promise.resolve().then(retry).catch(() => {}), 0)
      } }, copy('Thử lại', 'Retry'))
    ])
  })
  armToastDismiss(notice)
}
function showBusy() {
  ElMessage.warning(copy('Đang xử lý một bản ghi khác. Hoàn tất hoặc hủy trước khi tải tiếp.',
    'Another recording is being prepared. Finish or cancel it first.'))
}
export function notifyBulkDownloadBlocked() {
  ElMessage.warning(copy('Chỉ tải một bản ghi mỗi lần. Hãy chọn một phiên.',
    'Download one recording at a time. Select one session.'))
}

function unifiedToast(state) {
  const notice = manageReplayNotice({ title: '', duration: 0, showClose: false, offset: TOAST_OFFSET,
    customClass: 'pam-mp4-notification pam-mp4-notification--unified',
    message: h(ReplayNotice, { state }) })
  state.dismiss = () => notice.close()
  state.onHover = (hovered) => hoverToast(notice, hovered)
  return notice
}

// Original RDP/TAR downloads have no browser API for confirming that Save
// completed; state accurately indicates the download was REQUESTED, not saved.
export function notifyOriginalReplayDownload(row, startDownload) {
  if (activeDownload) { showBusy(); return false }
  const key = `${row.org_id || ''}:${row.id}`
  activeDownload = { key, kind: 'original' }
  const state = reactive({ status: 'processing', kind: 'original', stage: 'queued',
    current: 0, total: 0, percent: 0, record: replayDisplayName(row), dismiss: null })
  const notice = unifiedToast(state)
  try {
    startDownload()
    state.status = 'success'
    armToastDismiss(notice)
    window.setTimeout(() => {
      if (activeDownload?.key === key && activeDownload?.kind === 'original') activeDownload = null
    }, SUCCESS_DURATION_MS)
    return true
  } catch (error) {
    if (activeDownload?.key === key) activeDownload = null
    notice.close()
    showError(row, 'unexpected_error', () => notifyOriginalReplayDownload(row, startDownload))
    throw error
  }
}


// V12 — Own one conversion per tab, mirror a READ-ONLY visual state in other
// tabs. Every incoming job is authorized through Core before displaying its
// metadata. Remote tabs never start a second conversion or auto-download.
const localSyncJobs = new Map()
const trustedRemoteJobs = new Map()
const pendingRemoteJobs = new Map()
const verifyingRemoteJobs = new Set()

function publishOwnedState(key, sessionId, orgId, jobId, state, status = 'processing') {
  if (!jobId) return
  const packet = {
    kind: 'state', sessionId, orgId, jobId, status,
    stage: state.stage, current: state.current, total: state.total,
    percent: state.visualPercent, protocol: state.protocol,
    cancelling: Boolean(state.cancelling)
  }
  if (status === 'processing') localSyncJobs.set(key, packet)
  else localSyncJobs.delete(key)
  publishPamMp4(packet)
}
function applyRemoteState(entry, packet) {
  const state = entry.state
  if (state.status !== 'processing' && packet.status === 'processing') return
  state.record = String(packet.record || state.record).slice(0, 255)
  state.protocol = packet.protocol === 'rdp' ? 'rdp' : 'ssh'
  if (packet.status === 'processing') {
    state.stage = packet.cancelling ? 'cancelling' : String(packet.stage || 'queued')
    state.cancelling = Boolean(packet.cancelling)
    const current = Math.max(0, Number(packet.current) || 0)
    const total = Math.max(0, Number(packet.total) || 0)
    const step = `${current}:${total}:${state.stage}`
    if (step !== state.progressStepKey) {
      state.progressStepKey = step
      state.progressStepAt = Date.now()
    }
    state.current = current
    state.total = total
    state.visualPercent = Math.min(98, Math.max(state.visualPercent, Number(packet.percent) || 0))
  } else {
    state.status = packet.status === 'ready' ? 'success' : packet.status === 'cancelled' ? 'cancelled' : 'failed'
    state.stage = packet.status
    state.cancelling = false
    if (packet.status === 'ready') state.visualPercent = 100
    window.clearInterval(entry.animation)
    armToastDismiss(entry.notice)
    window.setTimeout(() => trustedRemoteJobs.delete(entry.id), 120000)
  }
}
async function receiveMp4Sync(packet) {
  if (packet.kind === 'hello') {
    // V13: a Player announces the session it is currently displaying.
    // Reply only with that session's job, rather than every Audits job.
    for (const current of localSyncJobs.values()) {
      const sameSession = !packet.sessionId ||
        String(current.sessionId).toLowerCase() === String(packet.sessionId).toLowerCase()
      const sameOrg = !packet.orgId || !current.orgId ||
        String(current.orgId).toLowerCase() === String(packet.orgId).toLowerCase()
      if (sameSession && sameOrg) publishPamMp4(current)
    }
    return
  }
  const key = `${packet.orgId || ''}:${packet.sessionId}`
  if (activeDownload?.kind === 'mp4' && activeDownload.key === key) return
  const id = `${key}:${packet.jobId}`
  const known = trustedRemoteJobs.get(id)
  if (known) { applyRemoteState(known, packet); return }
  pendingRemoteJobs.set(id, packet)
  if (verifyingRemoteJobs.has(id)) return
  verifyingRemoteJobs.add(id)
  try {
    const base = `/api/v1/terminal/sessions/${encodeURIComponent(packet.sessionId)}/replay/mp4/`
    const result = await request({ url: `${base}status/`, method: 'get',
      params: { job_id: packet.jobId, ...(packet.orgId ? { oid: packet.orgId } : {}) },
      disableFlashErrorMsg: true })
    if (!result || !['ready', 'queued', 'processing', 'failed', 'cancelled'].includes(result.status)) return
    const latest = pendingRemoteJobs.get(id) || packet
    const state = reactive({ kind: 'mp4', mirrored: true, status: 'processing',
      stage: 'queued', protocol: latest.protocol === 'rdp' ? 'rdp' : 'ssh',
      current: 0, total: 0, percent: 0, visualPercent: 0,
      record: typeof result.filename === 'string' ? result.filename.replace(/\.mp4$/i, '') : 'MP4 recording',
      cancelling: false, cancel: null, dismiss: null, progressStepAt: Date.now(), progressStepKey: '' })
    // The mirrored Cancel uses the authenticated Core endpoint directly.
    state.cancel = async () => {
      if (state.cancelling || state.status !== 'processing') return
      state.cancelling = true
      state.stage = 'cancelling'
      try {
        await request({ url: `${base}cancel/`, method: 'post',
          params: { job_id: packet.jobId, ...(packet.orgId ? { oid: packet.orgId } : {}) },
          disableFlashErrorMsg: true })
      } catch (_) {
        state.cancelling = false
        ElMessage.error(copy('Không thể gửi lệnh hủy.', 'Could not request cancellation.'))
      }
    }
    const notice = unifiedToast(state)
    const animation = window.setInterval(() => {
      if (state.status !== 'processing' || state.cancelling) return
      const target = rdpEstimatedTarget(state.stage, state.current, state.total,
        (Date.now() - state.progressStepAt) / 1000)
      if (target !== null) state.visualPercent = Math.min(98,
        state.visualPercent + Math.min(1.4, Math.max(0, target - state.visualPercent) * .12))
    }, 350)
    const entry = { id, state, notice, animation }
    trustedRemoteJobs.set(id, entry)
    applyRemoteState(entry, latest)
  } catch (_) { /* no rights / not found / temporarily rate-limited: do not mirror */ }
  finally {
    verifyingRemoteJobs.delete(id)
    pendingRemoteJobs.delete(id)
  }
}
if (typeof window !== 'undefined') subscribePamMp4((packet) => { void receiveMp4Sync(packet) })

function cancelJobsOnPageExit() {
  for (const { base, query, jobId } of activeJobs.values()) {
    const separator = query ? '&' : '?'
    const url = new URL(addBasePath(`${base}cancel/${query}${separator}job_id=${encodeURIComponent(jobId)}`), window.location.href)
    try {
      if (navigator.sendBeacon?.(url.href, new URLSearchParams())) continue
    } catch (_) { /* The worker lease will expire. */ }
    try {
      fetch(url.href, { method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }).catch(() => {})
    } catch (_) { /* The worker lease will expire. */ }
  }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', cancelJobsOnPageExit)

export function downloadReplayMp4(row) {
  if (Date.now() < exportThrottleUntil) {
    showReplayRateLimit(row, Math.ceil((exportThrottleUntil - Date.now()) / 1000))
    return Promise.resolve(false)
  }
  const id = row.id
  const oid = row.org_id || ''
  const key = `${oid}:${id}`
  if ([...trustedRemoteJobs.values()].some(entry => entry.state.status === 'processing' &&
    entry.id.startsWith(key + ':'))) {
    showBusy()
    return Promise.resolve(false)
  }
  if (activeDownload) {
    if (activeDownload.key === key && activeDownload.kind === 'mp4') return activeDownload.task
    showBusy()
    return Promise.resolve(false)
  }
  // De-bounce repeated clicks on an already cached recording.
  const now = Date.now()
  if (now - (recentReplayClicks.get(key) || 0) < 2500) return Promise.resolve(false)
  if (recentReplayClicks.size > 200) recentReplayClicks.clear()
  recentReplayClicks.set(key, now)
  const guard = { key, kind: 'mp4', task: null }
  activeDownload = guard
  const task = (async () => {
    const state = reactive({ status: 'processing', stage: 'queued', kind: 'mp4',
      protocol: String(row.protocol || '').toLowerCase(),
      current: 0, total: 0, percent: 0, visualPercent: 0,
      progressStepAt: Date.now(), progressStepKey: '', record: replayDisplayName(row),
      cancelling: false, cancel: null, dismiss: null })
    let notice = null
    let finished = false
    let succeeded = false
    let cancelled = false
    let failedCode = ''
    let started = null
    let earlyCancelRequested = false
    const base = `/api/v1/terminal/sessions/${encodeURIComponent(id)}/replay/mp4/`
    const query = oid ? `?oid=${encodeURIComponent(oid)}` : ''
    const ensureNotice = () => { if (!notice) notice = unifiedToast(state); return notice }
    const timer = window.setTimeout(() => { if (!finished) ensureNotice() }, 450)
    // Both protocols use the same visual estimator. No extra status polling.
    const progressAnimation = window.setInterval(() => {
      if (finished || state.cancelling || state.status !== 'processing') return
      const elapsed = (Date.now() - state.progressStepAt) / 1000
      const target = rdpEstimatedTarget(state.stage, state.current, state.total, elapsed)
      if (target == null) return
      const difference = Math.max(0, target - state.visualPercent)
      state.visualPercent = Math.min(98, state.visualPercent + Math.min(1.4, difference * 0.12))
    }, 350)
    state.cancel = async () => {
      if (state.cancelling || finished) return
      if (!started?.job_id) {
        state.cancelling = true
        earlyCancelRequested = true
        return // start request still pending; cancel after it returns
      }
      state.cancelling = true
      state.stage = 'cancelling'
      ensureNotice()
      publishOwnedState(key, id, oid, started.job_id, state)
      try {
        const answer = await request({ url: `${base}cancel/${query}`, method: 'post',
          params: { job_id: started.job_id }, disableFlashErrorMsg: true })
        if (answer?.status === 'ready') {
          // Worker completed before the cancel reached Core; receive the MP4.
          state.cancelling = false
        }
        // Otherwise polling waits for worker acknowledgement. The global lock
        // remains active until the worker has actually stopped.
      } catch (_) {
        state.cancelling = false
        state.stage = 'rendering'
        ElMessage.error(copy('Chưa gửi được yêu cầu hủy. Vui lòng thử lại.',
          'Cancellation could not be sent. Please retry.'))
      }
    }
    try {
      started = await request({ url: base + query, method: 'post', disableFlashErrorMsg: true })
      if (!started?.job_id) throw new Error('No export job returned')
      activeJobs.set(key, { base, query, jobId: started.job_id })
      publishOwnedState(key, id, oid, started.job_id, state)
      if (earlyCancelRequested) {
        state.cancelling = false
        await state.cancel()
      }
      const until = Date.now() + MAX_WAIT_MS
      while (Date.now() < until) {
        const result = await fetchReplayStatus({ url: `${base}status/${query}`, method: 'get',
          params: { job_id: started.job_id }, disableFlashErrorMsg: true }, state, until)
        if (typeof result.filename === 'string' && result.filename.endsWith('.mp4')) {
          state.record = result.filename.slice(0, -4)
        }
        if (result.status === 'ready') {
          activeJobs.delete(key) // do not cancel on browser Save-As/pagehide
          const separator = query ? '&' : '?'
          const url = `${base}download/${query}${separator}job_id=${encodeURIComponent(started.job_id)}`
          download(addBasePath(url))
          state.status = 'success'
          publishOwnedState(key, id, oid, started.job_id, state, 'ready')
          state.percent = 100
          state.visualPercent = 100
          succeeded = true
          finished = true
          ensureNotice()
          const currentNotice = notice
          armToastDismiss(currentNotice)
          return true
        }
        if (result.status === 'cancelled') {
          cancelled = true
          throw new Error('Export cancelled')
        }
        if (result.status === 'failed') {
          failedCode = result.error_code || 'unexpected_error'
          publishOwnedState(key, id, oid, started.job_id, state, 'failed')
          throw new Error('Export failed')
        }
        state.stage = state.cancelling ? 'cancelling' : (result.stage || result.status || 'queued')
        state.current = Math.max(0, Number(result.current) || 0)
        state.total = Math.max(0, Number(result.total) || 0)
        const stepKey = `${state.current}:${state.total}:${state.stage}`
        if (stepKey !== state.progressStepKey) {
          state.progressStepKey = stepKey
          state.progressStepAt = Date.now()
        }
        state.percent = Math.max(state.percent, percentFor(state.stage, state.current, state.total))
        publishOwnedState(key, id, oid, started.job_id, state)
        await sleep(POLL_INTERVAL_MS)
      }
      failedCode = 'processing_timeout'
      throw new Error('MP4 status polling exceeded limit')
    } catch (error) {
      finished = true
      if (cancelled) {
        state.status = 'cancelled'
        state.cancelling = false
        state.stage = 'cancelled'
        ensureNotice()
        armToastDismiss(notice)
        publishOwnedState(key, id, oid, started?.job_id, state, 'cancelled')
        return false
      }
      notice?.close()
      if (replayHttpStatus(error) === 429) {
        setReplayThrottle(error, row)
        return false
      }
      if (error?.response?.status === 409 || error?.status === 409) {
        showBusy()
        return false
      }
      // A failed browser request must not silently leave an expensive render
      // running; ask the worker to stop, with lease expiry as a fallback.
      if (started?.job_id) {
        request({ url: `${base}cancel/${query}`, method: 'post',
          params: { job_id: started.job_id }, disableFlashErrorMsg: true }).catch(() => {})
      }
      if (!failedCode) failedCode = error?.response?.status === 415
        ? 'unsupported_format' : 'unexpected_error'
      showError(row, failedCode)
      throw error
    } finally {
      finished = true
      window.clearTimeout(timer)
      window.clearInterval(progressAnimation)
      activeJobs.delete(key)
      if (activeDownload === guard) activeDownload = null
      if (!succeeded && !cancelled) notice?.close()
    }
  })()
  guard.task = task
  return task
}

// PAM MP4 V15 - Audit Duration Enhancement.

export function formatAuditDurationMs(value, t) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !['number', 'string'].includes(typeof value)
  ) {
    return t('PamReplayDurationUnknown')
  }

  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    return t('PamReplayDurationUnknown')
  }

  const ms = Number(value)

  if (!Number.isSafeInteger(ms) || ms < 0) {
    return t('PamReplayDurationUnknown')
  }

  if (ms > 0 && ms < 1000) {
    return t('PamDurationLessThanSecond')
  }

  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = seconds % 60

  return [hours, minutes, remaining]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

export function formatSessionDuration(row, t) {
  if (!row?.date_start || !row?.date_end) {
    return t('PamReplayDurationUnknown')
  }

  const start = Date.parse(row.date_start)
  const end = Date.parse(row.date_end)

  return formatAuditDurationMs(end - start, t)
}

export function formatReplayDuration(row, t) {
  if (
    row?.has_replay === false ||
    (row?.has_replay == null && row?.can_replay === false)
  ) {
    return t('PamReplayDurationUnavailable')
  }

  return formatAuditDurationMs(
    row?.replay_duration_ms,
    t
  )
}

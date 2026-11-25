<template>
  <BaseList
    :extra-actions="extraActions"
    :extra-more-actions="extraMoreActions"
    :url="url"
    :columns-meta="columnsMeta"
    :columns-show="columnsShow"
    :columns-exclude="columnsExclude"
  />
</template>

<script>
import BaseList from './BaseList'
import {
  formatSessionDuration,
  formatReplayDuration
} from '@/utils/auditDuration'
import { addBasePath, download } from '@/utils/common/index'
import { downloadReplayMp4, notifyOriginalReplayDownload, notifyBulkDownloadBlocked } from '@/utils/replayMp4'

const DOWNLOAD_INTERVAL = 300

export default {
  name: 'OfflineList',
  components: {
    BaseList
  },
  props: {
    url: {
      type: String,
      default: () => '/api/v1/terminal/sessions/?is_finished=1'
    }
  },
  data() {
    const vm = this
    return {
      extraMoreActions: this.$hasPerm('terminal.download_sessionreplay')
        ? [
            {
              name: 'downloadSelectedReplays',
              title: this.$t('DownloadReplay'),
              type: 'primary',
              icon: 'download',
              can: ({ selectedRows }) => selectedRows.length > 0,
              callback: ({ selectedRows }) => vm.downloadSelectedReplays(selectedRows)
            }
          ]
        : [],
      extraActions: [
        {
          name: 'replay',
          title: this.$t('Replay'),
          icon: 'fa-solid fa-play',
          type: 'warning',
          // TODO 当前版本 magnus 代理的 mongodb 协议的 session 不支持 replay
          can: ({ row }) =>
            vm.hasPerms(row, 'view') &&
            !(row.protocol === 'mongodb' && row.terminal.type === 'magnus'),
          callback: function ({ row, tableData }) {
            const oid = row.org_id || vm.$store.getters.currentOrg?.id || ''
            const replayUrl = `/luna/replay/${row.id}${oid ? `?oid=${encodeURIComponent(oid)}` : ''}`
            window.open(addBasePath(replayUrl))
          }
        },
        {
          name: 'download',
          title: this.$t('Download'),
          type: 'primary',
          can: ({ row }) => vm.canDownloadReplay(row),
          callback: function ({ row, tableData }) {
            if (['ssh', 'rdp'].includes(row.protocol)) {
              downloadReplayMp4(row).catch(() => {})
            } else {
              notifyOriginalReplayDownload(row, () =>
                download(`/api/v1/terminal/sessions/${row.id}/replay/download/`))
            }
          }
        }
      ],
      // PAM MP4 V15 - Audit Duration Enhancement.
      columnsShow: {
        min: ['number', 'actions'],
        default: [
          'number', 'user', 'asset', 'account', 'protocol',
          'date_start', 'duration', 'replay_duration_ms', 'actions'
        ]
      },
      columnsExclude: ['has_command'],
      columnsMeta: {
        duration: {
          label: this.$t('PamSessionDuration'),
          helpTip: this.$t('PamSessionDurationHelp'),
          minWidth: '145px',
          sortable: false,
          formatter: row => formatSessionDuration(
            row, key => this.$t(key)
          )
        },
        replay_duration_ms: {
          label: this.$t('PamReplayDuration'),
          helpTip: this.$t('PamReplayDurationHelp'),
          minWidth: '145px',
          sortable: false,
          formatter: row => formatReplayDuration(
            row, key => this.$t(key)
          )
        },
        command_amount: {
          label: this.$t('CommandsTotal')
        }
      }
    }
  },
  methods: {
    canDownloadReplay(row) {
      const isUnsupportedMongoDB = row.protocol === 'mongodb' && row.terminal?.type === 'magnus'
      return this.hasPerms(row, 'download') && !isUnsupportedMongoDB
    },
    async downloadSelectedReplays(selectedRows) {
      if (selectedRows.length > 1) {
        notifyBulkDownloadBlocked()
        return
      }
      const downloadableRows = selectedRows.filter((row) => this.canDownloadReplay(row))
      const unavailableCount = selectedRows.length - downloadableRows.length

      if (downloadableRows.length === 0) {
        this.$message.warning(this.$t('DownloadReplayNoneAvailable'))
        return
      }

      if (unavailableCount > 0) {
        try {
          await this.$confirm(
            this.$t('DownloadReplayPartialConfirm', {
              selected: selectedRows.length,
              available: downloadableRows.length,
              unavailable: unavailableCount
            }),
            this.$t('Confirm'),
            { type: 'warning' }
          )
        } catch {
          return
        }
      }

      for (const [index, row] of downloadableRows.entries()) {
        if (['ssh', 'rdp'].includes(row.protocol)) {
          await downloadReplayMp4(row).catch(() => {})
        } else {
          notifyOriginalReplayDownload(row, () =>
            download(`/api/v1/terminal/sessions/${row.id}/replay/download/`))
        }
        if (index < downloadableRows.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_INTERVAL))
        }
      }
    },
    hasPerms(row, type) {
      return row['can_replay'] && this.$hasPerm(`terminal.${type}_sessionreplay`)
    }
  }
}
</script>

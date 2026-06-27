import { useEffect, useState, useCallback } from 'react'
import { Button, Progress, Tag } from '../../ui'
import {
  IconSync,
  IconLoading,
  IconCheckCircle,
  IconCloseCircle,
  IconCloudDownload,
  IconEdit,
  IconApi,
  IconGitHub,
  IconFileText,
  IconExport,
} from '../../ui/Icons'
import type { UpdateStatus } from '@shared/types'
import PromptTemplateModal from '../PromptTemplateModal'
import MCPServerModal from '../MCPServerModal'
import { useLocale } from '../../i18n'

export default function GeneralSection() {
  const { t } = useLocale()
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [mcpModalOpen, setMcpModalOpen] = useState(false)

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion)
  }, [])

  // Subscribe to update status events
  useEffect(() => {
    window.electronAPI.onUpdateStatus((status: UpdateStatus) => {
      setUpdateStatus(status)
    })
    return () => {
      window.electronAPI.removeAllListeners('update:status')
    }
  }, [])

  const handleCheckUpdate = useCallback(() => {
    setUpdateStatus({ state: 'checking' })
    window.electronAPI.checkForUpdate()
  }, [])

  const handleInstallUpdate = useCallback(() => {
    window.electronAPI.installUpdate()
  }, [])

  return (
    <>
      {/* About & Version */}
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 'var(--font-size-xl)', fontWeight: 600, color: 'var(--text-primary)' }}>
          Anything Analyzer
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>v{appVersion}</span>
        <a
          href="https://github.com/Mouseww/anything-analyzer"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--text-muted)',
            transition: 'color 0.15s',
          }}
          title="GitHub"
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          onClick={e => {
            e.preventDefault()
            window.electronAPI.openExternal('https://github.com/Mouseww/anything-analyzer')
          }}
        >
          <IconGitHub size={18} />
        </a>
      </div>

      {/* Update */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        {updateStatus.state === 'idle' && (
          <Button size="sm" icon={<IconSync size={14} />} onClick={handleCheckUpdate}>
            {t('settings.checkForUpdates')}
          </Button>
        )}
        {updateStatus.state === 'checking' && (
          <Button size="sm" icon={<IconLoading size={14} />} disabled>
            {t('settings.checkingUpdates')}
          </Button>
        )}
        {updateStatus.state === 'not-available' && (
          <>
            <IconCheckCircle size={14} style={{ color: 'var(--color-success)' }} />
            <span style={{ fontSize: 'var(--font-size-base)' }}>{t('settings.upToDate')}</span>
            <Button size="sm" onClick={handleCheckUpdate}>{t('settings.checkAgain')}</Button>
          </>
        )}
        {updateStatus.state === 'available' && (
          <>
            <Tag color="info">{t('settings.versionAvailable', { version: updateStatus.info?.version ?? '' })}</Tag>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-base)' }}>{t('settings.downloading')}</span>
          </>
        )}
        {updateStatus.state === 'downloaded' && (
          <>
            <IconCloudDownload size={14} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: 'var(--font-size-base)' }}>{t('settings.versionReady', { version: updateStatus.info?.version ?? '' })}</span>
            <Button variant="primary" size="sm" onClick={handleInstallUpdate}>
              {t('settings.restartToUpdate')}
            </Button>
          </>
        )}
        {updateStatus.state === 'error' && (
          <>
            <IconCloseCircle size={14} style={{ color: 'var(--color-error)' }} />
            <span style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)' }}>{updateStatus.error}</span>
            <Button size="sm" onClick={handleCheckUpdate}>{t('settings.retry')}</Button>
          </>
        )}
      </div>

      {updateStatus.state === 'downloading' && (
        <Progress
          percent={Math.round(updateStatus.progress?.percent ?? 0)}
          status="normal"
        />
      )}

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
          {t('settings.managementTools')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <Button icon={<IconEdit size={14} />} block onClick={() => setTemplateModalOpen(true)}>
            {t('settings.managePromptTemplates')}
          </Button>
          <Button icon={<IconApi size={14} />} block onClick={() => setMcpModalOpen(true)}>
            {t('settings.manageMcpServers')}
          </Button>
        </div>
      </div>

      {/* Error Logs */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
          {t('settings.errorLogs')}
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 8 }}>
          {t('settings.errorLogsHelp')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<IconFileText size={14} />} onClick={() => window.electronAPI.openLogFolder()}>
            {t('settings.openLogFolder')}
          </Button>
          <Button icon={<IconExport size={14} />} onClick={() => window.electronAPI.exportLogs()}>
            {t('settings.exportLogs')}
          </Button>
        </div>
      </div>

      <PromptTemplateModal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} />
      <MCPServerModal open={mcpModalOpen} onClose={() => setMcpModalOpen(false)} />
    </>
  )
}

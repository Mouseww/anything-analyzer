import { useEffect, useState } from 'react'
import { InputNumber, Button, Switch, Badge, Tooltip, Modal, useToast } from '../../ui'
import {
  IconShield,
  IconExport,
  IconDelete,
  IconReload,
  IconWifi,
} from '../../ui/Icons'
import type { MitmProxyConfig } from '@shared/types'
import { useLocale } from '../../i18n'

export default function MitmProxySection() {
  const toast = useToast()
  const { t } = useLocale()
  const [mitmEnabled, setMitmEnabled] = useState(false)
  const [mitmPort, setMitmPort] = useState(8888)
  const [mitmRunning, setMitmRunning] = useState(false)
  const [mitmCaInstalled, setMitmCaInstalled] = useState(false)
  const [mitmCaInitialized, setMitmCaInitialized] = useState(false)
  const [mitmSystemProxy, setMitmSystemProxy] = useState(false)
  const [mitmLoading, setMitmLoading] = useState(false)
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false)
  const [localIPs, setLocalIPs] = useState<string[]>([])

  useEffect(() => {
    window.electronAPI.getMitmProxyConfig().then(config => {
      setMitmEnabled(config.enabled)
      setMitmPort(config.port)
      setMitmCaInstalled(config.caInstalled)
      setMitmSystemProxy(config.systemProxy)
    })
    window.electronAPI.getMitmProxyStatus().then(status => {
      setMitmRunning(status.running)
      setMitmCaInitialized(status.caInitialized)
      if (status.caInstalled !== undefined) setMitmCaInstalled(status.caInstalled)
      if (status.systemProxyEnabled !== undefined) setMitmSystemProxy(status.systemProxyEnabled)
      if (status.localIPs) setLocalIPs(status.localIPs)
    })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <div>
        <Badge
          color={mitmRunning ? 'var(--color-success)' : 'var(--text-muted)'}
          label={mitmRunning ? t('settings.running') : t('settings.stopped')}
          style={{ fontSize: 'var(--font-size-sm)' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--font-size-base)' }}>{t('settings.enableMitmProxy')}</span>
        <Switch checked={mitmEnabled} onChange={setMitmEnabled} />
      </div>

      {mitmEnabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--font-size-base)' }}>{t('settings.port')}</span>
            <InputNumber
              min={1024}
              max={65535}
              value={mitmPort}
              onChange={v => v !== null && setMitmPort(v)}
              style={{ width: 120 }}
            />
          </div>

          {/* System Proxy Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Tooltip title={t('settings.systemProxyTooltip')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-base)', cursor: 'default' }}>
                <IconWifi size={14} />
                {t('settings.setAsSystemProxy')}
              </span>
            </Tooltip>
            <Switch
              checked={mitmSystemProxy}
              disabled={mitmLoading}
              onChange={async (checked) => {
                setMitmLoading(true)
                try {
                  if (checked) {
                    const result = await window.electronAPI.enableMitmSystemProxy()
                    if (result.success) {
                      setMitmSystemProxy(true)
                      toast.success(t('settings.systemProxyEnabled'))
                    } else {
                      toast.error(result.error || t('settings.systemProxyEnableFailed'))
                    }
                  } else {
                    const result = await window.electronAPI.disableMitmSystemProxy()
                    if (result.success) {
                      setMitmSystemProxy(false)
                      toast.success(t('settings.systemProxyDisabled'))
                    } else {
                      toast.error(result.error || t('settings.systemProxyDisableFailed'))
                    }
                  }
                } finally {
                  setMitmLoading(false)
                }
              }}
            />
          </div>
          {mitmSystemProxy && (
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              {t('settings.systemProxyHelp')}
            </span>
          )}

          {/* CA Certificate Management */}
          <div style={{ marginTop: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>{t('settings.caManagement')}</span>
          </div>

          {!mitmCaInstalled ? (
            <>
              <div style={{
                padding: '6px 12px',
                background: 'var(--color-warning-bg)',
                border: '1px solid var(--color-warning-border)',
                borderLeft: '3px solid var(--color-warning)',
                borderRadius: 4,
                fontSize: 'var(--font-size-sm)',
                color: 'var(--text-primary)',
              }}>
                {t('settings.caNotInstalledWarning')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="primary"
                  icon={<IconShield size={14} />}
                  loading={mitmLoading}
                  onClick={async () => {
                    setMitmLoading(true)
                    try {
                      const result = await window.electronAPI.installMitmCA()
                      if (result.success) {
                        setMitmCaInstalled(true)
                        toast.success(t('settings.caInstalled'))
                      } else {
                        toast.error(result.error || t('settings.installFailed'))
                      }
                    } finally {
                      setMitmLoading(false)
                    }
                  }}
                >
                  {t('settings.installCaCertificate')}
                </Button>
                <Button
                  icon={<IconExport size={14} />}
                  onClick={() => window.electronAPI.exportMitmCA()}
                >
                  {t('settings.export')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div style={{
                padding: '6px 12px',
                background: 'var(--color-success-bg)',
                border: '1px solid var(--color-success-border)',
                borderLeft: '3px solid var(--color-success)',
                borderRadius: 4,
                fontSize: 'var(--font-size-sm)',
                color: 'var(--text-primary)',
              }}>
                {t('settings.caInstalledStatus')}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  icon={<IconDelete size={14} />}
                  loading={mitmLoading}
                  onClick={async () => {
                    setMitmLoading(true)
                    try {
                      const result = await window.electronAPI.uninstallMitmCA()
                      if (result.success) {
                        setMitmCaInstalled(false)
                        toast.success(t('settings.caUninstalled'))
                      } else {
                        toast.error(result.error || t('settings.uninstallFailed'))
                      }
                    } finally {
                      setMitmLoading(false)
                    }
                  }}
                >
                  {t('settings.uninstallCertificate')}
                </Button>
                <Button
                  icon={<IconExport size={14} />}
                  onClick={() => window.electronAPI.exportMitmCA()}
                >
                  {t('settings.export')}
                </Button>
                <Button
                  variant="danger"
                  icon={<IconReload size={14} />}
                  loading={mitmLoading}
                  onClick={() => setRegenConfirmOpen(true)}
                >
                  {t('settings.regenerateCa')}
                </Button>
              </div>
            </>
          )}

          {/* Usage Instructions */}
          {!mitmSystemProxy && (
            <div style={{ marginTop: 4 }}>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
                {t('settings.configureExternalProxy')}
              </span>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {localIPs.length > 0 ? localIPs.map(ip => (
                  <code key={ip} style={{
                    background: 'var(--color-surface)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: 'var(--font-size-sm)',
                    fontFamily: 'var(--font-mono)',
                    userSelect: 'all',
                  }}>
                    {ip}:{mitmPort}
                  </code>
                )) : (
                  <code style={{
                    background: 'var(--color-surface)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: 'var(--font-size-sm)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    http://&lt;{t('settings.localIp')}&gt;:{mitmPort}
                  </code>
                )}
              </div>
            </div>
          )}

          {/* Mobile cert download hint */}
          <div style={{
            marginTop: 4,
            padding: '8px 12px',
            background: 'var(--color-info-bg, rgba(59,130,246,0.08))',
            border: '1px solid var(--color-info-border, rgba(59,130,246,0.2))',
            borderRadius: 4,
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
          }}>
            {t('settings.mobileCertHint')}{' '}
            <code style={{
              background: 'var(--color-surface)',
              padding: '1px 5px',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-sm)',
              userSelect: 'all',
            }}>
              http://cert.anything.test
            </code>
          </div>
        </>
      )}

      <Button variant="primary" block onClick={async () => {
        const config: MitmProxyConfig = {
          enabled: mitmEnabled,
          port: mitmPort,
          caInstalled: mitmCaInstalled,
          systemProxy: mitmSystemProxy,
        }
        await window.electronAPI.saveMitmProxyConfig(config)
        toast.success(t('settings.mitmProxySaved'))
        const status = await window.electronAPI.getMitmProxyStatus()
        setMitmRunning(status.running)
        setMitmCaInitialized(status.caInitialized)
      }}>
        {t('settings.saveMitmProxySettings')}
      </Button>

      {/* Confirm modal for regenerating CA */}
      <Modal
        open={regenConfirmOpen}
        onClose={() => setRegenConfirmOpen(false)}
        title={t('settings.regenerateCa')}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setRegenConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                setRegenConfirmOpen(false)
                setMitmLoading(true)
                try {
                  await window.electronAPI.regenerateMitmCA()
                  setMitmCaInstalled(false)
                  setMitmRunning(false)
                  toast.success(t('settings.caRegenerated'))
                } finally {
                  setMitmLoading(false)
                }
              }}
            >
              {t('common.ok')}
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--font-size-base)' }}>
          {t('settings.regenerateCaConfirm')}
        </p>
      </Modal>
    </div>
  )
}

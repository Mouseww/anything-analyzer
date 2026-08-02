import { useEffect, useState } from 'react'
import { Input, PasswordInput, Select, InputNumber, Button, useToast } from '../../ui'
import type { ProxyConfig } from '@shared/types'
import { useLocale } from '../../i18n'

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 'var(--font-size-sm)',
  color: 'var(--text-secondary)',
}

const fieldStyle: React.CSSProperties = {
  marginBottom: 16,
}

export default function ProxySection() {
  const toast = useToast()
  const { t } = useLocale()
  const [proxyType, setProxyType] = useState<ProxyConfig['type']>('none')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(1080)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    window.electronAPI.getProxyConfig().then(config => {
      if (config) {
        setProxyType(config.type)
        setHost(config.host ?? '')
        setPort(config.port ?? 1080)
        setUsername(config.username ?? '')
        setPassword(config.password ?? '')
      }
    })
  }, [])

  const handleSave = async () => {
    if (proxyType !== 'none' && !host) {
      toast.warning(t('settings.proxyHostRequired'))
      return
    }
    const config: ProxyConfig = { type: proxyType, host, port, username, password }
    await window.electronAPI.saveProxyConfig(config)
    toast.success(t('settings.proxySaved'))
  }

  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{t('settings.proxyType')}</label>
        <Select
          value={proxyType}
          onChange={v => setProxyType(v as ProxyConfig['type'])}
          options={[
            { label: t('settings.noProxy'), value: 'none' },
            { label: 'HTTP', value: 'http' },
            { label: 'HTTPS', value: 'https' },
            { label: 'SOCKS5', value: 'socks5' },
          ]}
        />
      </div>

      {proxyType && proxyType !== 'none' && (
        <>
          <div style={fieldStyle}>
            <label style={labelStyle}>{t('settings.host')} *</label>
            <Input
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="127.0.0.1"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>{t('settings.port')} *</label>
            <InputNumber
              value={port}
              onChange={v => v !== null && setPort(v)}
              min={1}
              max={65535}
              style={{ width: '100%' }}
              placeholder="1080"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>{t('settings.usernameOptional')}</label>
            <Input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t('settings.noAuthPlaceholder')}
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>{t('settings.passwordOptional')}</label>
            <PasswordInput
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('settings.noAuthPlaceholder')}
            />
          </div>
        </>
      )}

      <Button variant="primary" block onClick={handleSave}>
        {t('settings.saveProxySettings')}
      </Button>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { InputNumber, Button, Input, Switch, Badge, useToast } from '../../ui'
import type { MCPServerSettings } from '@shared/types'
import { useLocale } from '../../i18n'

export default function MCPServerSection() {
  const toast = useToast()
  const { t } = useLocale()
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState(23816)
  const [authEnabled, setAuthEnabled] = useState(true)
  const [authToken, setAuthToken] = useState('')
  const [running, setRunning] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)

  useEffect(() => {
    window.electronAPI.getMCPServerConfig().then(config => {
      setEnabled(config.enabled)
      setPort(config.port)
      setAuthEnabled(config.authEnabled ?? true)
      setAuthToken(config.authToken ?? '')
    })
    window.electronAPI.getMCPServerStatus().then(status => {
      setRunning(status.running)
    })
  }, [])

  const regenerateToken = () => {
    setAuthToken(crypto.randomUUID())
  }

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(authToken)
      toast.success('Token copied')
    } catch {
      toast.error('Copy failed')
    }
  }

  const maskedToken = authToken
    ? authToken.slice(0, 8) + '••••••••' + authToken.slice(-4)
    : ''

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px',
    fontSize: 'var(--font-size-2xs)',
    minWidth: 'auto',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div>
        <Badge
          color={running ? 'var(--color-success)' : 'var(--text-muted)'}
          label={running ? '运行中' : '已停止'}
          style={{ fontSize: 'var(--font-size-sm)' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--font-size-base)' }}>启用 MCP Server</span>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      {enabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--font-size-base)' }}>端口</span>
            <InputNumber
              min={1024}
              max={65535}
              value={port}
              onChange={v => v !== null && setPort(v)}
              style={{ width: 120 }}
            />
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            外部工具配置 URL:{' '}
            <code style={{
              background: 'var(--color-surface)',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 'var(--font-size-sm)',
              fontFamily: 'var(--font-mono)',
            }}>
              http://localhost:{port}/mcp
            </code>
          </div>

          {/* Auth section */}
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 'var(--font-size-base)' }}>鉴权</span>
              <Switch checked={authEnabled} onChange={setAuthEnabled} />
            </div>

            {authEnabled && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Input
                    value={tokenVisible ? authToken : maskedToken}
                    onChange={e => { setAuthToken(e.target.value); setTokenVisible(true) }}
                    onFocus={() => setTokenVisible(true)}
                    onBlur={() => setTokenVisible(false)}
                    style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}
                  />
                  <Button onClick={copyToken} style={btnStyle}>复制</Button>
                  <Button onClick={regenerateToken} style={btnStyle}>重新生成</Button>
                </div>
                <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  外部工具需在请求头中设置: <code style={{
                    background: 'var(--color-surface)',
                    padding: '1px 4px',
                    borderRadius: 3,
                    fontFamily: 'var(--font-mono)',
                  }}>Authorization: Bearer {'<token>'}</code>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <Button variant="primary" block onClick={async () => {
        const config: MCPServerSettings = { enabled, port, authEnabled, authToken }
        await window.electronAPI.saveMCPServerConfig(config)
        toast.success('MCP Server 配置已保存')
        const status = await window.electronAPI.getMCPServerStatus()
        setRunning(status.running)
      }}>
        保存 MCP Server 设置
      </Button>
    </div>
  )
}

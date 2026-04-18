import { useEffect, useState } from 'react'
import { Input, PasswordInput, Select, InputNumber, Button, useToast } from '../../ui'
import type { LLMProviderConfig, LLMProviderType, OpenAIApiType } from '@shared/types'

const defaultUrls: Record<LLMProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  minimax: 'https://api.minimax.io/anthropic/v1',
  custom: '',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 'var(--font-size-sm)',
  color: 'var(--text-secondary)',
}

const fieldStyle: React.CSSProperties = {
  marginBottom: 16,
}

export default function LLMSection() {
  const toast = useToast()
  const [name, setName] = useState<LLMProviderType>('openai')
  const [apiType, setApiType] = useState<OpenAIApiType | undefined>('completions')
  const [baseUrl, setBaseUrl] = useState(defaultUrls.openai)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState<number>(4096)

  const showApiType = name === 'openai' || name === 'custom'

  useEffect(() => {
    window.electronAPI.getLLMConfig().then(config => {
      if (config) {
        setName(config.name)
        setApiType(config.apiType ?? 'completions')
        setBaseUrl(config.baseUrl)
        setApiKey(config.apiKey)
        setModel(config.model)
        setMaxTokens(config.maxTokens ?? 4096)
      }
    })
  }, [])

  const handleProviderChange = (value: string) => {
    const provider = value as LLMProviderType
    setName(provider)
    setBaseUrl(defaultUrls[provider])
    if (provider === 'anthropic' || provider === 'minimax') {
      setApiType(undefined)
    } else if (!apiType) {
      setApiType('completions')
    }
  }

  const handleSave = async () => {
    if (!baseUrl || !apiKey || !model) {
      toast.warning('请填写必填项（Base URL、API Key、Model）')
      return
    }
    const config: LLMProviderConfig = {
      name,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      ...(showApiType && apiType ? { apiType } : {}),
    }
    await window.electronAPI.saveLLMConfig(config)
    toast.success('LLM 配置已保存')
  }

  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle}>Provider *</label>
        <Select
          value={name}
          onChange={handleProviderChange}
          options={[
            { label: 'OpenAI', value: 'openai' },
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'MiniMax', value: 'minimax' },
            { label: 'Custom (OpenAI Compatible)', value: 'custom' },
          ]}
        />
      </div>

      {showApiType && (
        <div style={fieldStyle}>
          <label style={labelStyle}>API Type</label>
          <Select
            value={apiType ?? 'completions'}
            onChange={(v) => setApiType(v as OpenAIApiType)}
            options={[
              { label: 'Chat Completions (/chat/completions)', value: 'completions' },
              { label: 'Responses (/responses)', value: 'responses' },
            ]}
          />
        </div>
      )}

      <div style={fieldStyle}>
        <label style={labelStyle}>Base URL *</label>
        <Input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>API Key *</label>
        <PasswordInput
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>Model *</label>
        <Input
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder="gpt-4o / claude-sonnet-4-20250514 / MiniMax-M2.7 / ..."
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>Max Tokens</label>
        <InputNumber
          value={maxTokens}
          onChange={v => v !== null && setMaxTokens(v)}
          min={256}
          max={128000}
          style={{ width: '100%' }}
        />
      </div>

      <Button variant="primary" block onClick={handleSave}>
        保存 LLM 配置
      </Button>
    </div>
  )
}

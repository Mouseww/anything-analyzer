import { useEffect, useState } from 'react'
import { Input, PasswordInput, Select, InputNumber, Button, useToast } from '../../ui'
import type {
  ContextMode,
  CompressionMode,
  LLMProviderConfig,
  LLMProviderType,
  OpenAIApiType,
} from '@shared/types'

const defaultUrls: Record<LLMProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  minimax: 'https://api.minimax.io/anthropic/v1',
  cheaperinference: 'https://api.cheaperinference.com/v1',
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

const sectionTitleStyle: React.CSSProperties = {
  margin: '24px 0 12px',
  fontSize: 'var(--font-size-md)',
  fontWeight: 600,
  color: 'var(--text-primary)',
}

const helpStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-tertiary)',
}

export default function LLMSection() {
  const toast = useToast()
  const [name, setName] = useState<LLMProviderType>('openai')
  const [apiType, setApiType] = useState<OpenAIApiType | undefined>('completions')
  const [baseUrl, setBaseUrl] = useState(defaultUrls.openai)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [maxTokens, setMaxTokens] = useState<number>(4096)

  const [maxContextTokens, setMaxContextTokens] = useState(200000)
  const [compressionPeak, setCompressionPeak] = useState(85)
  const [compressionTarget, setCompressionTarget] = useState(55)
  const [contextMode, setContextMode] = useState<ContextMode>('index_first')
  const [compressionMode, setCompressionMode] = useState<CompressionMode>('rules')
  const [subagentEnabled, setSubagentEnabled] = useState(true)
  const [subagentThreshold, setSubagentThreshold] = useState(400)
  const [subagentChunkSize, setSubagentChunkSize] = useState(120)
  const [maxSubagents, setMaxSubagents] = useState(3)

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
        const budget = config.contextBudget
        if (budget) {
          if (budget.maxContextTokens) setMaxContextTokens(budget.maxContextTokens)
          if (budget.compressionPeak) setCompressionPeak(Math.round(budget.compressionPeak * 100))
          if (budget.compressionTarget) setCompressionTarget(Math.round(budget.compressionTarget * 100))
          if (budget.contextMode) setContextMode(budget.contextMode)
          if (budget.compressionMode) setCompressionMode(budget.compressionMode)
          if (budget.subagentEnabled !== undefined) setSubagentEnabled(budget.subagentEnabled)
          if (budget.subagentThreshold) setSubagentThreshold(budget.subagentThreshold)
          if (budget.subagentChunkSize) setSubagentChunkSize(budget.subagentChunkSize)
          if (budget.maxSubagents) setMaxSubagents(budget.maxSubagents)
        }
      }
    })
  }, [])

  const handleProviderChange = (value: string) => {
    const provider = value as LLMProviderType
    setName(provider)
    setBaseUrl(defaultUrls[provider])
    setModelOptions([])
    if (provider === 'anthropic' || provider === 'minimax') {
      setApiType(undefined)
    } else if (!apiType) {
      setApiType('completions')
    }
  }

  const buildConfig = (selectedModel: string): LLMProviderConfig => ({
    name,
    baseUrl,
    apiKey,
    model: selectedModel,
    maxTokens,
    ...(showApiType && apiType ? { apiType } : {}),
    contextBudget: {
      maxContextTokens,
      compressionPeak: compressionPeak / 100,
      compressionTarget: compressionTarget / 100,
      contextMode,
      compressionMode,
      reserveCompletionTokens: 8192,
      subagentEnabled,
      subagentThreshold,
      subagentChunkSize,
      maxSubagents,
    },
  })

  const handleLoadModels = async () => {
    if (!baseUrl || !apiKey) {
      toast.warning('请先填写 Base URL 和 API Key')
      return
    }
    setIsLoadingModels(true)
    try {
      const models = await window.electronAPI.listLLMModels(buildConfig(model))
      setModelOptions(models)
      if (!model && models.length > 0) setModel(models[0])
      toast.success(`已加载 ${models.length} 个模型`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleSave = async () => {
    if (!baseUrl || !apiKey || !model) {
      toast.warning('请填写必填项（Base URL、API Key、Model）')
      return
    }
    const config = buildConfig(model)
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
            { label: 'Cheaper Inference', value: 'cheaperinference' },
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
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o / claude-sonnet-4-20250514 / MiniMax-M2.7 / ..."
            list="llm-model-options"
          />
          <Button size="sm" loading={isLoadingModels} onClick={handleLoadModels}>
            加载模型
          </Button>
        </div>
        <datalist id="llm-model-options">
          {modelOptions.map(option => <option key={option} value={option} />)}
        </datalist>
        <div style={helpStyle}>可从服务端加载模型列表，也可继续手动输入模型 ID。</div>
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

      <div style={sectionTitleStyle}>上下文预算（分析 / 追问）</div>

      <div style={fieldStyle}>
        <label style={labelStyle}>上下文模式</label>
        <Select
          value={contextMode}
          onChange={(v) => setContextMode(v as ContextMode)}
          options={[
            { label: '索引优先（推荐，正文按需 tool 拉取）', value: 'index_first' },
            { label: '传统内联（正文直接进 prompt）', value: 'legacy_inline' },
          ]}
        />
        <div style={helpStyle}>默认不把 request/response 正文塞进首轮上下文，由模型调用 get_request_detail 获取。</div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>最大上下文 (tokens)</label>
        <InputNumber
          value={maxContextTokens}
          onChange={v => v !== null && setMaxContextTokens(v)}
          min={8192}
          max={1000000}
          step={1024}
          style={{ width: '100%' }}
        />
        <div style={helpStyle}>默认 200000。需与模型真实窗口匹配。</div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>压缩峰值 (%)</label>
        <InputNumber
          value={compressionPeak}
          onChange={v => v !== null && setCompressionPeak(v)}
          min={50}
          max={95}
          style={{ width: '100%' }}
        />
        <div style={helpStyle}>达到可用上下文的该比例时自动压缩。默认 85%。</div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>压缩目标 (%)</label>
        <InputNumber
          value={compressionTarget}
          onChange={v => v !== null && setCompressionTarget(v)}
          min={20}
          max={80}
          style={{ width: '100%' }}
        />
        <div style={helpStyle}>压缩后回落到可用上下文的该比例。默认 55%。</div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>压缩方式</label>
        <Select
          value={compressionMode}
          onChange={(v) => setCompressionMode(v as CompressionMode)}
          options={[
            { label: '规则压缩（默认，零额外调用）', value: 'rules' },
            { label: '混合（规则不足时 LLM 摘要）', value: 'hybrid' },
          ]}
        />
      </div>

      <div style={sectionTitleStyle}>超大任务子分析</div>

      <div style={fieldStyle}>
        <label style={labelStyle}>并行子分析</label>
        <Select
          value={subagentEnabled ? 'enabled' : 'disabled'}
          onChange={(value) => setSubagentEnabled(value === 'enabled')}
          options={[
            { label: '启用（推荐，仅超阈值触发）', value: 'enabled' },
            { label: '禁用', value: 'disabled' },
          ]}
        />
        <div style={helpStyle}>将超大请求索引拆成多个并行摘要任务，主分析只接收聚合发现和相关请求序号。</div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>触发阈值（请求数）</label>
        <InputNumber
          value={subagentThreshold}
          onChange={value => value !== null && setSubagentThreshold(value)}
          min={100}
          max={10000}
          step={50}
          style={{ width: '100%' }}
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>每个子任务请求数</label>
        <InputNumber
          value={subagentChunkSize}
          onChange={value => value !== null && setSubagentChunkSize(value)}
          min={40}
          max={250}
          step={10}
          style={{ width: '100%' }}
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>最大并行子任务</label>
        <InputNumber
          value={maxSubagents}
          onChange={value => value !== null && setMaxSubagents(value)}
          min={1}
          max={8}
          style={{ width: '100%' }}
        />
        <div style={helpStyle}>默认 3。并发越高速度越快，但会增加瞬时 API 请求和费用。</div>
      </div>

      <Button variant="primary" block onClick={handleSave}>
        保存 LLM 配置
      </Button>
    </div>
  )
}

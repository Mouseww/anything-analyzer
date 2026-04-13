import React, { useState } from 'react'
import { Button, Input, Modal, Select, Space, Spin, Tag } from 'antd'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ExperimentOutlined,
  LoadingOutlined
} from '@ant-design/icons'
import type { SessionStatus } from '../../shared/types'
import { ANALYSIS_PURPOSES } from '../../shared/types'

interface ControlBarProps {
  status: SessionStatus | null
  onStart: () => void
  onPause: () => void
  onStop: () => void
  onAnalyze: (purpose?: string) => void
  hasRequests: boolean
  isAnalyzing?: boolean
}

const ControlBar: React.FC<ControlBarProps> = ({
  status,
  onStart,
  onPause,
  onStop,
  onAnalyze,
  hasRequests,
  isAnalyzing = false
}) => {
  const [purposeId, setPurposeId] = useState<string>('auto')
  const [customText, setCustomText] = useState('')
  const [customModalOpen, setCustomModalOpen] = useState(false)

  const isRunning = status === 'running'
  const isPaused = status === 'paused'
  const isStopped = status === 'stopped' || status === null

  const handlePurposeChange = (value: string) => {
    if (value === 'custom') {
      window.electronAPI.setTargetViewVisible(false)
      setCustomModalOpen(true)
    } else {
      setPurposeId(value)
    }
  }

  const handleCustomConfirm = () => {
    const trimmed = customText.trim()
    if (trimmed) {
      setPurposeId('custom')
      setCustomModalOpen(false)
      window.electronAPI.setTargetViewVisible(true)
    }
  }

  const handleCustomCancel = () => {
    setCustomModalOpen(false)
    window.electronAPI.setTargetViewVisible(true)
  }

  const handleAnalyze = () => {
    if (purposeId === 'custom') {
      onAnalyze(customText.trim() || undefined)
    } else if (purposeId === 'auto') {
      onAnalyze(undefined)
    } else {
      onAnalyze(purposeId)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        background: '#1a1a1a',
        borderBottom: '1px solid #303030'
      }}
    >
      <Space size={8}>
        {/* Start button */}
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          disabled={!isStopped}
          onClick={onStart}
          style={
            isStopped
              ? { background: '#389e0d', borderColor: '#389e0d' }
              : undefined
          }
        >
          Start Capture
        </Button>

        {/* Pause button */}
        <Button
          icon={<PauseCircleOutlined />}
          disabled={!isRunning}
          onClick={onPause}
          style={
            isRunning
              ? { color: '#faad14', borderColor: '#faad14' }
              : undefined
          }
        >
          Pause
        </Button>

        {/* Stop button */}
        <Button
          danger
          icon={<StopOutlined />}
          disabled={!(isRunning || isPaused)}
          onClick={onStop}
        >
          Stop
        </Button>

        {/* Purpose selector */}
        <Select
          value={purposeId}
          onChange={handlePurposeChange}
          style={{ width: 160 }}
          disabled={isAnalyzing}
          options={ANALYSIS_PURPOSES.map(p => ({
            label: p.label,
            value: p.value,
          }))}
        />

        {/* Analyze button */}
        <Button
          type="primary"
          icon={<ExperimentOutlined />}
          disabled={!(isStopped && hasRequests) || isAnalyzing}
          loading={isAnalyzing}
          onClick={handleAnalyze}
        >
          {isAnalyzing ? 'Analyzing...' : 'Analyze'}
        </Button>
      </Space>

      {/* Status indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {purposeId === 'custom' && customText.trim() && (
          <Tag color="blue" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {customText.trim()}
          </Tag>
        )}
        {isRunning && (
          <Tag
            color="green"
            icon={<Spin indicator={<LoadingOutlined style={{ fontSize: 12 }} spin />} size="small" />}
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          >
            Capturing...
          </Tag>
        )}
        {isPaused && <Tag color="warning">Paused</Tag>}
        {isStopped && status !== null && <Tag color="default">Stopped</Tag>}
      </div>

      {/* Custom purpose modal */}
      <Modal
        title="自定义分析目的"
        open={customModalOpen}
        onOk={handleCustomConfirm}
        onCancel={handleCustomCancel}
        okText="确认"
        cancelText="取消"
        okButtonProps={{ disabled: !customText.trim() }}
      >
        <Input.TextArea
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="输入你希望 AI 重点分析的内容，例如：分析用户注册流程中的所有加密操作"
          autoSize={{ minRows: 3, maxRows: 8 }}
          maxLength={500}
          showCount
        />
      </Modal>
    </div>
  )
}

export default ControlBar

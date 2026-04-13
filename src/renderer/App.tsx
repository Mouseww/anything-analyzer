import React, { useState, useCallback, useRef, useEffect } from 'react'
import { ConfigProvider, Layout, Tabs, theme, Typography } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'

import SessionList from './components/SessionList'
import BrowserPanel from './components/BrowserPanel'
import TabBar from './components/TabBar'
import ControlBar from './components/ControlBar'
import SettingsModal from './components/SettingsModal'
import RequestLog from './components/RequestLog'
import RequestDetail from './components/RequestDetail'
import HookLog from './components/HookLog'
import StorageView from './components/StorageView'
import ReportView from './components/ReportView'
import { useSession } from './hooks/useSession'
import { useCapture } from './hooks/useCapture'
import { useTabs } from './hooks/useTabs'

const { Sider, Content } = Layout
const { Text } = Typography

/** Default browser area ratio (0.0 ~ 1.0) */
const DEFAULT_BROWSER_RATIO = 0.7
/** ControlBar height in px */
const CONTROL_BAR_HEIGHT = 40
/** Drag handle height in px */
const DRAG_HANDLE_HEIGHT = 6

function App(): React.ReactElement {
  const {
    sessions,
    currentSessionId,
    currentSession,
    loadSessions,
    createSession,
    selectSession,
    deleteSession,
    startCapture,
    pauseCapture,
    stopCapture
  } = useSession()

  const { tabs, activeTabId, activeTabUrl, activateTab, closeTab, createTab } = useTabs()

  const [settingsOpen, setSettingsOpen] = useState(false)

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    window.electronAPI.setTargetViewVisible(false)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    window.electronAPI.setTargetViewVisible(true)
  }, [])
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [browserRatio, setBrowserRatio] = useState(DEFAULT_BROWSER_RATIO)
  const [activeTab, setActiveTab] = useState('requests')

  /** Ref to the content area for measuring available height */
  const contentRef = useRef<HTMLDivElement>(null)
  /** Ref to browser placeholder for reporting exact bounds to main process */
  const placeholderRef = useRef<HTMLDivElement>(null)
  /** Whether we are currently dragging the resize handle */
  const isDragging = useRef(false)

  const { requests, hooks, snapshots, reports, isAnalyzing, analysisError, streamingContent, startAnalysis } = useCapture(currentSessionId)

  const selectedRequest = requests.find(r => r.id === selectedRequestId) || null

  // Navigate browser to session URL when session changes
  useEffect(() => {
    if (currentSession?.target_url) {
      window.electronAPI.navigate(currentSession.target_url).catch((err) => {
        console.error('Session navigation failed:', err)
      })
    }
  }, [currentSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Report exact browser placeholder bounds to main process via ResizeObserver
  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return

    const reportBounds = () => {
      const rect = el.getBoundingClientRect()
      window.electronAPI.syncBrowserBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }

    const observer = new ResizeObserver(reportBounds)
    observer.observe(el)
    reportBounds() // initial report

    return () => observer.disconnect()
  }, [])

  // Browser navigation handlers
  const handleNavigate = useCallback(async (url: string) => {
    try {
      await window.electronAPI.navigate(url)
    } catch (err) {
      console.error('Navigation failed:', err)
    }
  }, [])

  const handleBack = useCallback(async () => {
    try {
      await window.electronAPI.goBack()
    } catch (err) {
      console.error('Go back failed:', err)
    }
  }, [])

  const handleForward = useCallback(async () => {
    try {
      await window.electronAPI.goForward()
    } catch (err) {
      console.error('Go forward failed:', err)
    }
  }, [])

  const handleReload = useCallback(async () => {
    try {
      await window.electronAPI.reload()
    } catch (err) {
      console.error('Reload failed:', err)
    }
  }, [])

  // --- Drag resize logic ---
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !contentRef.current) return
      const contentRect = contentRef.current.getBoundingClientRect()
      // Available height = content height minus BrowserPanel(~40) and ControlBar
      const browserPanelHeight = 41 // BrowserPanel with border
      const availableTop = contentRect.top + browserPanelHeight
      const availableHeight = contentRect.height - browserPanelHeight - CONTROL_BAR_HEIGHT
      if (availableHeight <= 0) return

      const mouseY = ev.clientY - availableTop
      const newRatio = Math.max(0.15, Math.min(0.85, mouseY / availableHeight))
      setBrowserRatio(newRatio)
      // Sync to main process (throttled via requestAnimationFrame)
      window.electronAPI.setBrowserRatio(newRatio)
    }

    const onMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  // Analyze handler
  const handleAnalyze = useCallback(async (purpose?: string) => {
    if (!currentSessionId) return
    setActiveTab('report')
    await startAnalysis(currentSessionId, purpose)
  }, [currentSessionId, startAnalysis])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 6,
          colorBgContainer: '#1f1f1f',
          colorBgElevated: '#1f1f1f'
        },
        components: {
          Layout: {
            siderBg: '#141414',
            bodyBg: '#141414'
          },
          List: {
            colorBorder: 'transparent'
          }
        }
      }}
    >
      <Layout style={{ width: '100vw', height: '100vh' }}>
        {/* Left sidebar - Session List */}
        <Sider
          width={220}
          style={{
            borderRight: '1px solid #303030',
            overflow: 'hidden'
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <SessionList
            sessions={sessions}
            currentSessionId={currentSessionId}
            onSelect={selectSession}
            onCreate={createSession}
            onDelete={deleteSession}
          />

          {/* Settings button at the very bottom of sidebar */}
          <div
            style={{
              padding: '8px 16px',
              borderTop: '1px solid #303030',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#8c8c8c',
              transition: 'color 0.2s',
              flexShrink: 0
            }}
            onClick={() => openSettings()}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLElement).style.color = '#d9d9d9'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLElement).style.color = '#8c8c8c'
            }}
          >
            <SettingOutlined />
            <Text type="secondary" style={{ fontSize: 13 }}>
              Settings
            </Text>
          </div>
          </div>
        </Sider>

        {/* Right main area */}
        <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={contentRef}
            style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}
          >
          {/* Browser tab bar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
            onCreate={() => createTab()}
          />

          {/* Browser panel - address bar + nav buttons */}
          <BrowserPanel
            currentUrl={activeTabUrl}
            onNavigate={handleNavigate}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
          />

          {/* Browser view placeholder — native WebContentsView overlays this area */}
          <div
            ref={placeholderRef}
            style={{
              flex: `${browserRatio} 0 0`,
              position: 'relative',
              minHeight: 80
            }}
          />

          {/* Drag resize handle */}
          <div
            onMouseDown={handleDragStart}
            style={{
              height: DRAG_HANDLE_HEIGHT,
              cursor: 'row-resize',
              background: '#252525',
              borderTop: '1px solid #303030',
              borderBottom: '1px solid #303030',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            {/* Visual grip indicator */}
            <div style={{
              width: 36,
              height: 2,
              borderRadius: 1,
              background: '#555'
            }} />
          </div>

          {/* Control bar - capture buttons + status */}
          <ControlBar
            status={currentSession?.status ?? null}
            onStart={startCapture}
            onPause={pauseCapture}
            onStop={stopCapture}
            onAnalyze={handleAnalyze}
            hasRequests={requests.length > 0}
            isAnalyzing={isAnalyzing}
          />

          {/* Data panel area with tabs */}
          <div className="data-panel" style={{ flex: `${1 - browserRatio} 0 0`, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 120 }}>
            {currentSession ? (
              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                size="small"
                style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '0 12px' }}
                items={[
                  {
                    key: 'requests',
                    label: `Requests (${requests.length})`,
                    children: (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <RequestLog requests={requests} selectedId={selectedRequestId} onSelect={setSelectedRequestId} />
                        <RequestDetail request={selectedRequest} hooks={hooks} />
                      </div>
                    )
                  },
                  {
                    key: 'hooks',
                    label: `Hooks (${hooks.length})`,
                    children: <HookLog hooks={hooks} />
                  },
                  {
                    key: 'storage',
                    label: `Storage (${snapshots.length})`,
                    children: <StorageView snapshots={snapshots} />
                  },
                  {
                    key: 'report',
                    label: 'Report',
                    children: (
                      <ReportView
                        report={reports[0] || null}
                        isAnalyzing={isAnalyzing}
                        analysisError={analysisError}
                        streamingContent={streamingContent}
                        onReAnalyze={handleAnalyze}
                      />
                    )
                  }
                ]}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text type="secondary">Select or create a session to get started</Text>
              </div>
            )}
          </div>
          </div>
        </Content>
      </Layout>

      {/* Settings modal */}
      <SettingsModal open={settingsOpen} onClose={closeSettings} />

      {/* Make Ant Design Tabs content panels fill available space and scroll */}
      <style>{`
        .data-panel {
          min-width: 0;
        }
        .data-panel .ant-tabs {
          min-width: 0;
        }
        .data-panel .ant-tabs-content-holder {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .data-panel .ant-tabs-content {
          flex: 1;
          overflow: hidden;
          min-width: 0;
        }
        .data-panel .ant-tabs-tabpane-active {
          height: 100%;
          overflow-y: auto;
          overflow-x: hidden;
          min-width: 0;
        }
      `}</style>
    </ConfigProvider>
  )
}

export default App

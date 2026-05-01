import React, { useState, useCallback, useRef, useEffect } from 'react'

import Titlebar from './components/Titlebar'
import type { AppView } from './components/Titlebar'
import StatusBar from './components/StatusBar'
import SessionList from './components/SessionList'
import BrowserPanel from './components/BrowserPanel'
import TabBar from './components/TabBar'
import AnalyzeBar from './components/AnalyzeBar'
import SettingsModal from './components/SettingsModal'
import { THEMES, DEFAULT_THEME } from './theme'
import RequestLog from './components/RequestLog'
import RequestDetail from './components/RequestDetail'
import HookLog from './components/HookLog'
import StorageView from './components/StorageView'
import ReportView from './components/ReportView'
import InteractionLog from './components/InteractionLog'
import { useSession } from './hooks/useSession'
import { useCapture } from './hooks/useCapture'
import { useTabs } from './hooks/useTabs'
import { useConfirm } from './hooks/useConfirm'
import { useToast } from './ui/Toast'

import { LocaleProvider } from './i18n'
import { zh } from './i18n/zh'
import { en } from './i18n/en'
import type { LocaleKey } from './i18n'

function App(): React.ReactElement {
  const toast = useToast()
  const { confirm, ConfirmDialog } = useConfirm()

  const {
    sessions,
    currentSessionId,
    currentSession,
    loadSessions,
    createSession,
    selectSession,
    deleteSession,
    startCapture,
    resumeCapture,
    pauseCapture,
    stopCapture
  } = useSession()

  const { tabs, activeTabId, activeTabUrl, isActiveTabLoading, activateTab, closeTab, createTab } = useTabs()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeView, setActiveView] = useState<AppView>('browser')
  const [createTrigger, setCreateTrigger] = useState(0)

  // Theme & locale state (persisted to localStorage)
  const [appTheme, setAppTheme] = useState<string>(() => {
    const saved = localStorage.getItem('app-theme')
    return saved && THEMES.some(t => t.id === saved) ? saved : DEFAULT_THEME
  })
  const [appLocale, setAppLocale] = useState<'en' | 'zh'>(() => {
    return (localStorage.getItem('app-locale') as 'en' | 'zh') || 'zh'
  })

  // Simple t() for App-level strings (outside LocaleProvider context)
  const localeMaps: Record<string, Record<string, string>> = { zh, en }
  const t = useCallback((key: LocaleKey, vars?: Record<string, string | number>) => {
    let text = localeMaps[appLocale]?.[key] ?? zh[key] ?? key
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, String(v))
      })
    }
    return text
  }, [appLocale]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleThemeChange = useCallback((themeId: string) => {
    setAppTheme(themeId)
    localStorage.setItem('app-theme', themeId)
    if (themeId === 'dark') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', themeId)
    }
  }, [])

  const handleLocaleToggle = useCallback(() => {
    setAppLocale(prev => {
      const next = prev === 'zh' ? 'en' : 'zh'
      localStorage.setItem('app-locale', next)
      return next
    })
  }, [])

  // Apply theme attribute on mount
  useEffect(() => {
    if (appTheme === 'dark') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', appTheme)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    window.electronAPI.setTargetViewVisible(false)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    if (activeView === 'browser' && currentSession) {
      window.electronAPI.setTargetViewVisible(true)
    }
  }, [activeView, currentSession])

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [selectedSeqs, setSelectedSeqs] = useState<number[]>([])
  const [activeTab, setActiveTab] = useState('requests')

  /** Ref to browser placeholder for reporting exact bounds to main process */
  const placeholderRef = useRef<HTMLDivElement>(null)

  const { requests, hooks, snapshots, reports, interactions, isAnalyzing, analysisError, streamingContent, startAnalysis, cancelAnalysis, chatHistory, isChatting, chatError, sendFollowUp, clearCaptureData } = useCapture(currentSessionId)

  const selectedRequest = requests.find(r => r.id === selectedRequestId) || null

  // Navigate browser to session URL when session changes
  // Also enable standalone fingerprint protection
  useEffect(() => {
    setSelectedSeqs([])
    setSelectedRequestId(null)
    const setup = async (): Promise<void> => {
      if (currentSessionId) {
        // Switch to session's isolated partition (hides old tabs, restores/creates new)
        // Navigation to target_url is handled in main process when a blank tab is created
        await window.electronAPI.enableFingerprint(currentSessionId)
      } else {
        await window.electronAPI.disableFingerprint()
      }
    }
    setup().catch((err) => {
      console.error('Session setup failed:', err)
    })
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
    reportBounds()

    return () => observer.disconnect()
  }, [])

  // Hide/show browser view based on active view and session
  useEffect(() => {
    if (activeView === 'browser' && currentSession) {
      window.electronAPI.setTargetViewVisible(true)
    } else {
      window.electronAPI.setTargetViewVisible(false)
    }
  }, [activeView, currentSession])

  // Browser navigation handlers
  const handleNavigate = useCallback(async (url: string) => {
    try { await window.electronAPI.navigate(url) } catch (err) { console.error('Navigation failed:', err) }
  }, [])

  const handleBack = useCallback(async () => {
    try { await window.electronAPI.goBack() } catch (err) { console.error('Go back failed:', err) }
  }, [])

  const handleForward = useCallback(async () => {
    try { await window.electronAPI.goForward() } catch (err) { console.error('Go forward failed:', err) }
  }, [])

  const handleReload = useCallback(async () => {
    try { await window.electronAPI.reload() } catch (err) { console.error('Reload failed:', err) }
  }, [])

  // Analyze handler
  const handleAnalyze = useCallback(async (purpose?: string) => {
    if (!currentSessionId) return
    setActiveView('report')
    await startAnalysis(currentSessionId, purpose, selectedSeqs.length > 0 ? selectedSeqs : undefined)
  }, [currentSessionId, startAnalysis, selectedSeqs])

  // Cancel analysis handler
  const handleCancelAnalysis = useCallback(async () => {
    if (!currentSessionId) return
    await cancelAnalysis(currentSessionId)
  }, [currentSessionId, cancelAnalysis])

  // Export requests handler
  const handleExport = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.electronAPI.exportRequests(currentSessionId)
    } catch (err) {
      console.error('Export failed:', err)
    }
  }, [currentSessionId])

  // Clear browser environment (with confirmation)
  // Hide native WebContentsView so the confirm dialog is not obscured
  const handleClearEnv = useCallback(async () => {
    window.electronAPI.setTargetViewVisible(false)
    const ok = await confirm(t('data.clearEnvConfirm'), { okText: t('data.clear') })
    if (!ok) {
      if (activeView === 'browser' && currentSession) {
        window.electronAPI.setTargetViewVisible(true)
      }
      return
    }
    try {
      await window.electronAPI.clearBrowserEnv()
      toast.success(t('toast.envCleared'))
    } catch (err) {
      console.error('Clear env failed:', err)
      toast.error(t('toast.envClearFailed'))
    }
    if (activeView === 'browser' && currentSession) {
      window.electronAPI.setTargetViewVisible(true)
    }
  }, [toast, confirm, t, activeView, currentSession])

  // Clear capture data for re-analysis
  const handleClearData = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await clearCaptureData(currentSessionId)
      setSelectedRequestId(null)
      setSelectedSeqs([])
      toast.success(t('toast.dataCleared'))
    } catch (err) {
      console.error('Clear data failed:', err)
      toast.error(t('toast.dataClearFailed'))
    }
  }, [currentSessionId, clearCaptureData, toast])

  const handleFollowUp = useCallback(async (msg: string) => {
    if (!currentSessionId) return
    await sendFollowUp(currentSessionId, msg)
  }, [currentSessionId, sendFollowUp])

  // Pill button style for capture controls in browser address bar
  const pillStyle: React.CSSProperties = {
    padding: '5px 14px',
    borderRadius: 6,
    fontSize: 'var(--font-size-2xs)',
    cursor: 'pointer',
    border: 'none',
    whiteSpace: 'nowrap',
    lineHeight: 1.2,
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
  }
  const pillActive: React.CSSProperties = { ...pillStyle, background: 'var(--color-success-bg)', color: 'var(--color-success)', border: '1px solid var(--color-success-border)' }
  const pillDisabled: React.CSSProperties = { ...pillStyle, background: 'var(--color-active)', color: 'var(--text-disabled)', cursor: 'not-allowed' }
  const pillStart: React.CSSProperties = { ...pillStyle, background: 'var(--color-success)', color: '#000', padding: '5px 18px' }
  const pillPause: React.CSSProperties = { ...pillStyle, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', border: '1px solid var(--color-warning-border)' }
  const pillStop: React.CSSProperties = { ...pillStyle, background: 'var(--color-error-bg)', color: 'var(--color-error)', border: '1px solid var(--color-error-border)' }
  const pillPauseActive: React.CSSProperties = { ...pillStyle, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', border: '1px solid var(--color-warning)' }

  // Build capture slot for BrowserPanel
  const buildCaptureSlot = () => {
    if (!currentSessionId) return null
    if (!currentSession?.status || currentSession.status === 'stopped') {
      return (
        <>
          <button style={pillStart} onClick={startCapture}>● {t('browser.start')}</button>
          <button style={pillDisabled}>⏸ {t('browser.pause')}</button>
          <button style={pillDisabled}>■ {t('browser.stop')}</button>
        </>
      )
    }
    if (currentSession.status === 'running') {
      return (
        <>
          <button style={pillActive}>● {t('browser.start')}</button>
          <button style={pillPause} onClick={pauseCapture}>⏸ {t('browser.pause')}</button>
          <button style={pillStop} onClick={stopCapture}>■ {t('browser.stop')}</button>
        </>
      )
    }
    if (currentSession.status === 'paused') {
      return (
        <>
          <button style={pillPauseActive}>⏸ {t('browser.pause')}</button>
          <button style={pillStart} onClick={resumeCapture}>▶ {t('browser.resume')}</button>
          <button style={pillStop} onClick={stopCapture}>■ {t('browser.stop')}</button>
        </>
      )
    }
    return null
  }

  // Empty state guide for when no session is selected
  const renderEmptyGuide = () => (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
      padding: 40,
      color: 'var(--text-muted)',
    }}>
      <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.5px' }}>
        {t('session.emptyTitle')}
      </div>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        fontSize: 'var(--font-size-base)',
        lineHeight: 1.6,
      }}>
        {[
          { step: '1', icon: '＋', text: t('session.emptyStep1') },
          { step: '2', icon: '🌐', text: t('session.emptyStep2') },
          { step: '3', icon: '●', text: t('session.emptyStep3') },
          { step: '4', icon: '⚡', text: t('session.emptyStep4') },
        ].map(({ step, icon, text }) => (
          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'var(--color-active)',
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              flexShrink: 0,
            }}>
              {step}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{text}</span>
          </div>
        ))}
      </div>
      <button
        style={{
          marginTop: 8,
          padding: '8px 24px',
          borderRadius: 6,
          background: 'var(--text-primary)',
          color: 'var(--color-base)',
          border: 'none',
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}
        onClick={() => setCreateTrigger(n => n + 1)}
      >
        {t('session.newSession')}
      </button>
    </div>
  )

  // Render the Browser view — ONLY browser, no data panel
  const renderBrowserView = () => (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
      {currentSession ? (
        <>
          {/* Browser tab bar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
            onCreate={() => createTab()}
          />

          {/* Browser panel - address bar + nav buttons + capture pills */}
          <BrowserPanel
            currentUrl={activeTabUrl}
            isLoading={isActiveTabLoading}
            onNavigate={handleNavigate}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
            captureSlot={buildCaptureSlot()}
            onClearEnv={handleClearEnv}
            onToggleDevTools={() => window.electronAPI.toggleDevTools()}
          />

          {/* Browser view placeholder — native WebContentsView overlays this area */}
          <div
            ref={placeholderRef}
            style={{
              flex: 1,
              position: 'relative',
              minHeight: 80
            }}
          />
        </>
      ) : (
        renderEmptyGuide()
      )}
    </div>
  )

  // Inspector sub-tab styles
  const inspectorTabStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    letterSpacing: '0.3px',
    padding: '0',
    background: 'none',
    border: 'none',
    fontFamily: 'var(--font-sans)',
    height: '100%',
    boxShadow: 'none',
    transition: 'color 0.15s',
  }
  const inspectorTabActiveStyle: React.CSSProperties = {
    ...inspectorTabStyle,
    color: 'var(--text-primary)',
    boxShadow: 'inset 0 -2px 0 var(--text-primary)',
  }
  const inspectorTabCountStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-3xs)',
    color: 'var(--text-muted)',
    marginLeft: 5,
  }

  // Render the Inspector view — sub-tabs + left/right split + bottom AnalyzeBar
  const renderInspectorView = () => (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
      {currentSession ? (
        <>
          {/* Sub-tabs: Requests / Hooks / Storage + Capture controls */}
          <div style={{
            height: 36,
            background: 'var(--color-bar)',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'stretch',
            padding: '0 16px',
            gap: 24,
            flexShrink: 0,
          }}>
            <button
              style={activeTab === 'requests' ? inspectorTabActiveStyle : inspectorTabStyle}
              onClick={() => setActiveTab('requests')}
            >
              {t('data.requests')} <span style={inspectorTabCountStyle}>{requests.length}</span>
            </button>
            <button
              style={activeTab === 'hooks' ? inspectorTabActiveStyle : inspectorTabStyle}
              onClick={() => setActiveTab('hooks')}
            >
              {t('data.hooks')} <span style={inspectorTabCountStyle}>{hooks.length}</span>
            </button>
            <button
              style={activeTab === 'storage' ? inspectorTabActiveStyle : inspectorTabStyle}
              onClick={() => setActiveTab('storage')}
            >
              {t('data.storage')} <span style={inspectorTabCountStyle}>{snapshots.length}</span>
            </button>
            <button
              style={activeTab === 'interactions' ? inspectorTabActiveStyle : inspectorTabStyle}
              onClick={() => setActiveTab('interactions')}
            >
              {t('data.interactions')} <span style={inspectorTabCountStyle}>{interactions.length}</span>
            </button>

            {/* Spacer */}
            <div style={{ flex: 1 }} />

            {/* Clear data button */}
            {currentSessionId && requests.length > 0 && (
              <button
                style={{
                  fontSize: 'var(--font-size-2xs)',
                  color: 'var(--text-muted)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 4px',
                  fontFamily: 'var(--font-sans)',
                  whiteSpace: 'nowrap',
                }}
                onClick={async () => {
                  const ok = await confirm(t('data.clearDataConfirm'), {
                    okText: t('data.clear'),
                  })
                  if (ok) handleClearData()
                }}
                title={t('data.clearDataConfirm')}
              >{t('data.clearData')}</button>
            )}

            {/* Capture controls in Inspector */}
            {currentSessionId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {buildCaptureSlot()}
              </div>
            )}
          </div>

          {/* Tab content */}
          {activeTab === 'requests' ? (
            /* Left-right split: request list (420px) + detail panel */
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, minWidth: 400, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <RequestLog requests={requests} selectedId={selectedRequestId} onSelect={(r) => setSelectedRequestId(r.id)} selectedSeqs={selectedSeqs} onSelectedSeqsChange={setSelectedSeqs} />
              </div>
              <div style={{ width: 400, minWidth: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <RequestDetail request={selectedRequest} hooks={hooks} />
              </div>
            </div>
          ) : activeTab === 'hooks' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: '0 12px' }}>
              <HookLog hooks={hooks} />
            </div>
          ) : activeTab === 'storage' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: '0 12px' }}>
              <StorageView snapshots={snapshots} />
            </div>
          ) : activeTab === 'interactions' ? (
            <div style={{ flex: 1, overflow: 'hidden', padding: '0 12px' }}>
              <InteractionLog interactions={interactions} />
            </div>
          ) : null}

          {/* Bottom AnalyzeBar */}
          <AnalyzeBar
            onAnalyze={handleAnalyze}
            onExport={handleExport}
            hasRequests={requests.length > 0}
            isAnalyzing={isAnalyzing}
            isStopped={currentSession.status !== 'running'}
            selectedSeqCount={selectedSeqs.length}
            totalCount={requests.length}
          />
        </>
      ) : (
        renderEmptyGuide()
      )}
    </div>
  )

  // Render the Report view
  const renderReportView = () => (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
      {currentSession ? (
        <ReportView
          report={reports[0] || null}
          isAnalyzing={isAnalyzing}
          analysisError={analysisError}
          streamingContent={streamingContent}
          onReAnalyze={handleAnalyze}
          onCancelAnalysis={handleCancelAnalysis}
          chatHistory={chatHistory}
          isChatting={isChatting}
          chatError={chatError}
          onSendFollowUp={handleFollowUp}
          sessionName={currentSession?.name}
          requests={requests}
          hooks={hooks}
        />
      ) : (
        renderEmptyGuide()
      )}
    </div>
  )

  return (
    <LocaleProvider locale={appLocale}>
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-base)' }}>
      {/* Custom Titlebar */}
      <Titlebar
        theme={appTheme}
        onThemeChange={handleThemeChange}
        locale={appLocale}
        onLocaleToggle={handleLocaleToggle}
        activeView={activeView}
        onViewChange={setActiveView}
        requestCount={requests.length}
      />

      {/* Main content area: Sidebar + View */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left sidebar */}
        <div style={{
          width: 'var(--sidebar-width)',
          minWidth: 220,
          maxWidth: 220,
          borderRight: '1px solid var(--color-border)',
          background: 'var(--color-sidebar)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <SessionList
            sessions={sessions}
            currentSessionId={currentSessionId}
            onSelect={selectSession}
            onCreate={createSession}
            onDelete={deleteSession}
            onOpenSettings={openSettings}
            activeRequestCount={requests.length}
            createTrigger={createTrigger}
          />
        </div>

        {/* Main view area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-content)' }}>
          {activeView === 'browser' && renderBrowserView()}
          {activeView === 'inspector' && renderInspectorView()}
          {activeView === 'report' && renderReportView()}
        </div>
      </div>

      {/* Status bar */}
      <StatusBar
        status={currentSession?.status ?? null}
        requestCount={requests.length}
        hookCount={hooks.length}
        interactionCount={interactions.length}
        sessionName={currentSession?.name}
        activeView={activeView}
        llmModel={reports[0]?.llm_model}
        tokenCount={reports[0] ? (reports[0].prompt_tokens ?? 0) + (reports[0].completion_tokens ?? 0) : undefined}
      />

      {/* Settings modal */}
      <SettingsModal open={settingsOpen} onClose={closeSettings} currentSessionId={currentSession?.id ?? null} />
      {/* Confirm dialog (portal) */}
      {ConfirmDialog}
    </div>
    </LocaleProvider>
  )
}

export default App

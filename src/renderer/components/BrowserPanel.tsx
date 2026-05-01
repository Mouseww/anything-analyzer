import React, { useState, useCallback } from 'react'
import { Button } from '../ui'
import { IconArrowLeft, IconArrowRight, IconReload, IconSend, IconDelete, IconCode } from '../ui/Icons'
import { useLocale } from '../i18n'
import styles from './BrowserPanel.module.css'

interface BrowserPanelProps {
  currentUrl?: string
  isLoading?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  captureSlot?: React.ReactNode
  onClearEnv?: () => void
  onToggleDevTools?: () => void
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({
  currentUrl = '',
  isLoading = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  captureSlot,
  onClearEnv,
  onToggleDevTools,
}) => {
  const [addressValue, setAddressValue] = useState(currentUrl)
  const { t } = useLocale()

  // Sync when currentUrl prop changes externally
  React.useEffect(() => {
    setAddressValue(currentUrl)
  }, [currentUrl])

  const handleNavigate = useCallback(() => {
    const url = addressValue.trim()
    if (!url) return

    const finalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`
    setAddressValue(finalUrl)
    onNavigate(finalUrl)
  }, [addressValue, onNavigate])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleNavigate()
    },
    [handleNavigate]
  )

  return (
    <div className={styles.panel}>
      {/* Navigation buttons */}
      <div className={styles.navBtns}>
        <Button variant="ghost" size="sm" iconOnly icon={<IconArrowLeft size={14} />} onClick={onBack} title="Back" />
        <Button variant="ghost" size="sm" iconOnly icon={<IconArrowRight size={14} />} onClick={onForward} title="Forward" />
        <Button variant="ghost" size="sm" iconOnly icon={<IconReload size={14} />} onClick={onReload} title="Reload" />
        {onToggleDevTools && (
          <Button variant="ghost" size="sm" iconOnly icon={<IconCode size={14} />} title="DevTools" onClick={onToggleDevTools} />
        )}
        {onClearEnv && (
          <Button variant="ghost" size="sm" iconOnly icon={<IconDelete size={14} />} title={t('data.clearEnv')} onClick={onClearEnv} />
        )}
      </div>

      {/* Address bar */}
      <div className={styles.addressBar}>
        <input
          className={styles.addressInput}
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
        />
        <Button variant="ghost" size="sm" iconOnly icon={<IconSend size={14} />} onClick={handleNavigate} title="Navigate" />
      </div>

      {/* Capture controls slot */}
      {captureSlot && <div className={styles.captureControls}>{captureSlot}</div>}

      {/* Loading progress bar */}
      {isLoading && <div className={styles.loadingBar} />}
    </div>
  )
}

export default BrowserPanel

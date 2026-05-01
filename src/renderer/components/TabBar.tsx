import React, { useState } from 'react'
import { IconPlus, IconClose, IconLoading } from '../ui/Icons'
import type { BrowserTab } from '@shared/types'
import styles from './TabBar.module.css'

interface TabBarProps {
  tabs: BrowserTab[]
  activeTabId: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: () => void
}

/** Extracts a display label for a tab: title > hostname > 'New Tab' */
function getTabLabel(tab: BrowserTab): string {
  if (tab.title && tab.title !== 'New Tab') return tab.title
  if (tab.url) {
    try { return new URL(tab.url).hostname || 'New Tab' } catch { /* invalid URL */ }
  }
  return 'New Tab'
}

const TabBar: React.FC<TabBarProps> = ({ tabs, activeTabId, onActivate, onClose, onCreate }) => {
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null)

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isHovered = tab.id === hoveredTabId
          const label = getTabLabel(tab)

          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
              onClick={() => onActivate(tab.id)}
              onMouseEnter={() => setHoveredTabId(tab.id)}
              onMouseLeave={() => setHoveredTabId(null)}
            >
              <span className={styles.tabLabel} title={tab.url || label}>
                {tab.isLoading && <IconLoading size={10} />}
                {label}
              </span>
              {(isHovered || isActive) && (
                <span
                  className={styles.closeBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                  }}
                  style={{ opacity: 1 }}
                >
                  <IconClose size={10} />
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className={styles.newTabBtn} onClick={onCreate} title="New Tab">
        <IconPlus size={12} />
      </div>
    </div>
  )
}

export default TabBar

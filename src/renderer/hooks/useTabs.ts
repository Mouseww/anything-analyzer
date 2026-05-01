import { useState, useEffect, useCallback } from "react";
import type { BrowserTab } from "@shared/types";

export interface UseTabsReturn {
  tabs: BrowserTab[];
  activeTabId: string | null;
  activeTabUrl: string;
  isActiveTabLoading: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  createTab: (url?: string) => void;
}

/**
 * useTabs — React hook for managing browser tab state.
 * Synchronizes with the main process TabManager via IPC events.
 */
export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Derive active tab URL
  const activeTabUrl = tabs.find((t) => t.id === activeTabId)?.url || "";
  const isActiveTabLoading = tabs.find((t) => t.id === activeTabId)?.isLoading || false;

  // Load initial tab state
  useEffect(() => {
    window.electronAPI.listTabs().then((initialTabs) => {
      setTabs(initialTabs);
      const active = initialTabs.find((t) => t.isActive);
      if (active) setActiveTabId(active.id);
    });
  }, []);

  // Listen for tab events from main process
  useEffect(() => {
    window.electronAPI.onTabCreated((tab: BrowserTab) => {
      setTabs((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.id === tab.id)) return prev;
        return [
          ...prev.map((t) => ({ ...t, isActive: false })),
          { ...tab, isActive: true },
        ];
      });
      setActiveTabId(tab.id);
    });

    window.electronAPI.onTabClosed((data: { tabId: string }) => {
      setTabs((prev) => prev.filter((t) => t.id !== data.tabId));
      setActiveTabId((prev) => (prev === data.tabId ? null : prev));
    });

    window.electronAPI.onTabActivated(
      (data: { tabId: string; url: string; title: string }) => {
        setTabs((prev) =>
          prev.map((t) => ({
            ...t,
            isActive: t.id === data.tabId,
          })),
        );
        setActiveTabId(data.tabId);
      },
    );

    window.electronAPI.onTabUpdated(
      (data: { tabId: string; url?: string; title?: string; isLoading?: boolean }) => {
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== data.tabId) return t;
            return {
              ...t,
              url: data.url ?? t.url,
              title: data.title ?? t.title,
              isLoading: data.isLoading ?? t.isLoading,
            };
          }),
        );
      },
    );

    return () => {
      window.electronAPI.removeAllListeners("tabs:created");
      window.electronAPI.removeAllListeners("tabs:closed");
      window.electronAPI.removeAllListeners("tabs:activated");
      window.electronAPI.removeAllListeners("tabs:updated");
    };
  }, []);

  const activateTab = useCallback((tabId: string) => {
    window.electronAPI.activateTab(tabId);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    window.electronAPI.closeTab(tabId);
  }, []);

  const createTab = useCallback((url?: string) => {
    window.electronAPI.createTab(url);
  }, []);

  return { tabs, activeTabId, activeTabUrl, isActiveTabLoading, activateTab, closeTab, createTab };
}

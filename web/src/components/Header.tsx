import React from 'react';
import { PROFILE_INFO, type ProfileName } from '../types.ts';
import { Icon } from './common/Icon.tsx';

interface HeaderProps {
  profile: ProfileName;
  profileLabel?: string;
  compareCount?: number;
  isOfflineMode?: boolean;
  isBusy?: boolean;
  statusMessage?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  profileLabel,
  compareCount = 0,
  isOfflineMode,
  isBusy = false,
  statusMessage,
  isCollapsed,
  onToggleCollapse,
  onOpenSettings,
  onOpenAbout,
}) => {
  const profileMeta = PROFILE_INFO[profile];
  const badgeLabel = `${profileLabel || profileMeta?.shortLabel || profile}${compareCount > 0 ? ` +${compareCount}` : ''}`;
  const shortBusyLabel =
    statusMessage && /download|fetch/i.test(statusMessage)
      ? 'Loading…'
      : statusMessage && /init|lookup|profile/i.test(statusMessage)
        ? 'Starting…'
        : 'Routing…';

  return (
    <div
      className="header"
      onClick={() => {
        if (isCollapsed) onToggleCollapse();
      }}
    >
      <div className="header-top">
        <div className="header-title-wrap">
          <h1
            title={isCollapsed ? "Gabi's Router: click to expand" : undefined}
            onClick={(e) => {
              if (isCollapsed) {
                e.stopPropagation();
                onToggleCollapse();
              }
            }}
          >
            <span className="header-logo" aria-hidden="true">
              <img src="/logo.png" alt="" className="header-logo-img" />
            </span>
            <span className="header-brand-text">Gabi&apos;s Router</span>
          </h1>
          {isCollapsed && (
            <span id="header-profile-badge" className="header-profile-badge">
              {badgeLabel}
            </span>
          )}
          {isOfflineMode && (
            <span className="header-offline-pill" title="Offline Mode Active">
              Offline
            </span>
          )}
          {isBusy && (
            <span
              className="header-busy-pill"
              role="status"
              aria-live="polite"
              title={statusMessage || 'Calculating route...'}
            >
              <span className="status-spinner status-spinner-sm" aria-hidden="true" />
              <span>{shortBusyLabel}</span>
            </span>
          )}
        </div>
        <div className="header-actions">
          <button
            id="btn-settings"
            type="button"
            className="collapse-btn"
            title="Settings & Offline Data"
            aria-label="Settings"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
          >
            <Icon name="settings" size={15} />
          </button>
          <button
            id="btn-about"
            type="button"
            className="collapse-btn"
            title="About Gabi's Router"
            aria-label="About Gabi's Router"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAbout();
            }}
          >
            <Icon name="info" size={15} />
          </button>
          <button
            id="btn-toggle-collapse"
            type="button"
            className="collapse-btn"
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            <Icon
              className="sidebar-collapse-icon"
              name={isCollapsed ? 'panel-left-open' : 'panel-left-close'}
              size={16}
            />
            <Icon
              id="collapse-icon"
              className="mobile-collapse-icon"
              name="chevron-up"
              size={16}
            />
          </button>
        </div>
      </div>
    </div>
  );
};


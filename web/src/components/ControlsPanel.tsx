import React, { useEffect, useRef, useState } from 'react';
import type { useRouting } from '../hooks/useRouting.ts';
import type { useOffline } from '../hooks/useOffline.ts';
import {
  getSlotColor,
  MAX_ROUTE_SLOTS,
  MAX_ROUTES,
  PROFILE_INFO,
  PROFILE_ORDER,
  ROUTE_COLOR_PALETTE,
  type LatLon,
  type ProfileName,
} from '../types.ts';
import { routeToGpx, downloadGpxFile } from '../utils/gpx.ts';
import { getShareableRouteUrl, isNativePlatform } from '../platform.ts';
import { Header } from './Header.tsx';
import { WaypointList } from './WaypointList.tsx';
import { ProfileEditorPanel } from './ProfileEditorPanel.tsx';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

interface ControlsPanelProps {
  routing: ReturnType<typeof useRouting>;
  offline: ReturnType<typeof useOffline>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isProfileEditorOpen: boolean;
  onToggleProfileEditor: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  getMapCenter?: () => { lat: number; lon: number };
  onFlyTo?: (lon: number, lat: number) => void;
  editingWaypointIndex?: number | null;
  onClearEditingWaypoint?: () => void;
}

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  routing,
  offline,
  isCollapsed,
  onToggleCollapse,
  isProfileEditorOpen,
  onToggleProfileEditor,
  onOpenSettings,
  onOpenAbout,
  getMapCenter,
  onFlyTo,
  editingWaypointIndex,
  onClearEditingWaypoint,
}) => {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const routeSectionRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [openColorSlotIdx, setOpenColorSlotIdx] = useState<number | null>(null);

  useEffect(() => {
    if (openColorSlotIdx === null) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('.profile-color-picker-wrap')) {
        setOpenColorSlotIdx(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenColorSlotIdx(null);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openColorSlotIdx]);

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      routing.importGpxFile(file);
    }
    e.target.value = '';
  };

  const handleUseMyLocationAt = (onResolved: (point: LatLon) => void) => {
    if (!('geolocation' in navigator)) {
      routing.setStatus('This browser cannot find your location.', true);
      return;
    }
    routing.setStatus('Finding your location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onResolved({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          name: 'My location',
        });
      },
      (err) => {
        const GEOLOCATION_ERRORS: Record<number, string> = {
          1: 'Location permission was denied. Allow it in browser settings and try again.',
          2: 'Your location is not available right now.',
          3: 'Finding your location took too long. Try again.',
        };
        routing.setStatus(
          GEOLOCATION_ERRORS[err.code] ?? `Could not find your location: ${err.message}`,
          true,
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  };

  const handleSetWaypointAt = (
    index: number,
    point: LatLon,
    mode: 'replace' | 'insert-start' | 'append',
  ) => {
    if (mode === 'replace') {
      routing.moveWaypoint(index, point);
    } else if (mode === 'insert-start') {
      routing.insertWaypointAtLeg(point, 0);
    } else {
      routing.addWaypoint(point, 'append');
    }
  };

  const handleShare = async () => {
    const url = getShareableRouteUrl();
    try {
      if (typeof window !== 'undefined' && window.AndroidNative?.shareText) {
        if (window.AndroidNative.shareText("Gabi's Router route", url)) {
          return;
        }
      }
      if (navigator.share && (isNativePlatform() || window.matchMedia('(pointer: coarse)').matches)) {
        await navigator.share({ title: "Gabi's Router route", url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        routing.setStatus('Link copied. Anyone who opens it sees this route.');
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (err: any) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      routing.setStatus(`Could not share: ${err.message || String(err)}`, true);
    }
  };

  const handleExportGpx = async () => {
    if (!routing.currentRoute) return;
    const startName = routing.waypoints[0]?.name;
    const endName = routing.waypoints[routing.waypoints.length - 1]?.name;
    const profileTag = routing.profile.startsWith('custom:')
      ? routing.getProfileMeta(routing.profile).shortLabel
      : routing.profile;
    const trackName =
      startName && endName ? `${startName} to ${endName}` : `${profileTag}_route`;
    const filename = `${trackName.replace(/[/\\?%*:|"<>]/g, '_')}.gpx`;
    await downloadGpxFile(routeToGpx(routing.currentRoute, trackName), filename);
    routing.setStatus(`Route exported as ${filename}`);
  };

  const isBusy = routing.isRouting || offline.downloadProgress.active;
  const activeRouteSlots = routing.slots
    .map((slot, slotIdx) => ({ slot, slotIdx }))
    .filter(({ slot }) => (slot.routeIdx ?? 0) === routing.activeRouteIdx);

  return (
    <div
      id="controls"
      ref={controlsRef}
      className={`${isCollapsed ? 'collapsed' : ''} ${!isCollapsed && isProfileEditorOpen ? 'editor-open' : ''}`}
    >
      <div className="controls-main-col">
        <Header
          profile={routing.profile}
          profileLabel={routing.getProfileMeta(routing.profile).shortLabel}
          compareCount={Math.max(0, routing.slots.length - 1)}
          isOfflineMode={offline.isOfflineMode}
          isBusy={isBusy}
          statusMessage={routing.status || offline.downloadProgress.message}
          isCollapsed={isCollapsed}
          onToggleCollapse={onToggleCollapse}
          onOpenSettings={onOpenSettings}
          onOpenAbout={onOpenAbout}
        />

        {isCollapsed && (
          <div
            className="sidebar-rail-body"
            title="Expand sidebar"
            onClick={onToggleCollapse}
          >
            <div className="sidebar-rail-slots">
              {routing.slots.map((slot, slotIdx) => {
                const slotColor = getSlotColor(slot, slotIdx);
                const slotMeta = routing.getProfileMeta(slot.profile);
                const slotLabel =
                  routing.routeCount > 1
                    ? `R${(slot.routeIdx ?? 0) + 1} · ${slotMeta.shortLabel}`
                    : slotMeta.shortLabel;
                const isSlotActive = slotIdx === routing.activeSlotIdx;
                return (
                  <button
                    key={slotIdx}
                    type="button"
                    className={`rail-slot-btn ${isSlotActive ? 'active' : ''}`}
                    title={
                      routing.slots.length > 1
                        ? `${slotLabel} (click to focus)`
                        : `${slotLabel} (click to expand)`
                    }
                    aria-label={slotLabel}
                    onClick={(e) => {
                      if (routing.slots.length > 1) {
                        e.stopPropagation();
                        routing.setActiveSlot(slotIdx);
                      }
                    }}
                  >
                    <span
                      className={`rail-slot-dot ${slot.isRouting ? 'is-routing' : ''}`}
                      style={{ backgroundColor: slotColor.line }}
                    />
                  </button>
                );
              })}
            </div>

            {routing.waypoints.length > 0 && (
              <div className="sidebar-rail-waypoints">
                <span className="sidebar-rail-divider" aria-hidden="true" />
                <span
                  className="rail-wp-badge rail-wp-start"
                  title={`Start: ${routing.waypoints[0].name || `${routing.waypoints[0].lat.toFixed(4)}, ${routing.waypoints[0].lon.toFixed(4)}`}`}
                >
                  A
                </span>
                {routing.waypoints.length >= 2 && (
                  <>
                    <span className="rail-wp-stem" aria-hidden="true" />
                    {routing.waypoints.length > 2 && (
                      <>
                        <span
                          className="rail-wp-via"
                          title={`${routing.waypoints.length - 2} intermediate waypoint${routing.waypoints.length - 2 > 1 ? 's' : ''}`}
                        >
                          +{routing.waypoints.length - 2}
                        </span>
                        <span className="rail-wp-stem" aria-hidden="true" />
                      </>
                    )}
                    <span
                      className="rail-wp-badge rail-wp-end"
                      title={`End: ${routing.waypoints[routing.waypoints.length - 1].name || `${routing.waypoints[routing.waypoints.length - 1].lat.toFixed(4)}, ${routing.waypoints[routing.waypoints.length - 1].lon.toFixed(4)}`}`}
                    >
                      B
                    </span>
                  </>
                )}
              </div>
            )}

            {(isBusy || offline.isOfflineMode) && (
              <div className="sidebar-rail-status">
                {isBusy && (
                  <span
                    className="status-spinner status-spinner-sm"
                    title={routing.status || 'Calculating route...'}
                  />
                )}
                {offline.isOfflineMode && (
                  <span className="rail-offline-tag" title="Offline Mode Active">
                    OFF
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="route-section" ref={routeSectionRef}>
          <div className="route-tabs-bar" role="tablist" aria-label="Routes">
            <div className="route-tabs-list">
              {Array.from({ length: routing.routeCount }).map((_, rIdx) => {
                const rSlots = routing.slots
                  .map((slot, slotIdx) => ({ slot, slotIdx }))
                  .filter(({ slot }) => (slot.routeIdx ?? 0) === rIdx);
                const isRouteActive = rIdx === routing.activeRouteIdx;
                const isRouteRouting = rSlots.some(({ slot }) => slot.isRouting);
                const primaryEntry = rSlots[0];
                const primaryColor = primaryEntry
                  ? getSlotColor(primaryEntry.slot, primaryEntry.slotIdx)
                  : ROUTE_COLOR_PALETTE[0];
                const wpCount = primaryEntry?.slot.waypoints.length ?? 0;
                return (
                  <div
                    key={rIdx}
                    className={`route-tab ${isRouteActive ? 'active' : ''}`}
                    style={
                      isRouteActive
                        ? ({ '--route-tab-color': primaryColor.line } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <button
                      id={`btn-route-tab-${rIdx}`}
                      type="button"
                      role="tab"
                      aria-selected={isRouteActive}
                      className="route-tab-btn"
                      title={`Switch to Route ${rIdx + 1} (${wpCount} points)`}
                      onClick={() => routing.setActiveRoute(rIdx)}
                    >
                      <span
                        className={`route-tab-dot ${isRouteRouting ? 'is-routing' : ''}`}
                        style={{ backgroundColor: primaryColor.line }}
                      />
                      <span>Route {rIdx + 1}</span>
                    </button>
                    {routing.routeCount > 1 && (
                      <button
                        id={`btn-remove-route-${rIdx}`}
                        type="button"
                        className="route-tab-close"
                        title={`Remove Route ${rIdx + 1}`}
                        aria-label={`Remove Route ${rIdx + 1}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          routing.removeRoute(rIdx);
                        }}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {routing.routeCount < MAX_ROUTES && (
              <div className="route-tabs-actions">
                <button
                  id="btn-add-route"
                  type="button"
                  className="btn-toolbar-mini btn-add-route"
                  title="Add a new empty route with its own profile selector"
                  onClick={() => routing.addRoute('empty')}
                >
                  <span>+ Route</span>
                </button>
                <button
                  id="btn-clone-route"
                  type="button"
                  className="btn-toolbar-mini btn-clone-route"
                  title="Clone current route waypoints and profile into a new route"
                  onClick={() => routing.addRoute('clone')}
                >
                  <span>Clone</span>
                </button>
              </div>
            )}
          </div>

          <div className="field profile-field">
            <div className="profile-field-header">
              <label htmlFor="profile-select" className="profile-header-label">
                <span>{activeRouteSlots.length > 1 ? 'Profiles' : 'Profile'}</span>
                <InfoButton
                  tooltip={`${routing.getProfileMeta(routing.profile)?.summary || ''} Use + Profile to compare profiles on the same waypoints, or + Route / Clone above to work on an independent route.`}
                  ariaLabel="About Routing Profiles"
                />
              </label>
              <div className="profile-header-actions">
                <button
                  id="btn-open-profile-editor"
                  type="button"
                  className={`btn-toolbar-mini btn-edit-profile ${isProfileEditorOpen ? 'active' : ''}`}
                  title={isProfileEditorOpen ? 'Close Profile Editor' : 'Open Profile Editor to customize or create profiles'}
                  onClick={onToggleProfileEditor}
                >
                  <Icon name="sliders" size={11} />
                  <span>{isProfileEditorOpen ? 'Close editor' : 'Edit profile'}</span>
                </button>
                {activeRouteSlots.length < MAX_ROUTE_SLOTS && (
                  <button
                    id="btn-add-compare-profile"
                    type="button"
                    className="btn-toolbar-mini btn-add-profile"
                    title="Compare another profile on this route's waypoints"
                    onClick={() => routing.addProfileSlot()}
                  >
                    <span>+ Profile</span>
                  </button>
                )}
              </div>
            </div>

            <div className="profile-slots-list">
              {activeRouteSlots.map(({ slot, slotIdx }, localIdx) => {
                const slotColor = getSlotColor(slot, slotIdx);
                const isPickerOpen = openColorSlotIdx === slotIdx;
                const slotMeta = routing.getProfileMeta(slot.profile);
                return (
                  <div
                    key={slotIdx}
                    className={`profile-slot-row ${slot.isRouting ? 'is-routing' : ''}`}
                  >
                    <div className="profile-color-picker-wrap">
                      <button
                        type="button"
                        className={`profile-slot-dot profile-slot-dot-btn ${isPickerOpen ? 'active' : ''} ${slot.isRouting ? 'is-routing' : ''}`}
                        style={{ backgroundColor: slotColor.line }}
                        title={`Colour: ${slotColor.name} (click to change)`}
                        aria-label={`Change colour (${slotColor.name})`}
                        aria-expanded={isPickerOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenColorSlotIdx(isPickerOpen ? null : slotIdx);
                        }}
                      />
                      {isPickerOpen && (
                        <div className="profile-color-popover" role="menu" aria-label="Select route colour">
                          {ROUTE_COLOR_PALETTE.map((c) => {
                            const isSelected = c.id === slotColor.id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                className={`profile-color-swatch ${isSelected ? 'selected' : ''}`}
                                style={{ backgroundColor: c.line }}
                                title={c.name}
                                aria-label={c.name}
                                aria-checked={isSelected}
                                role="menuitemradio"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  routing.setSlotColor(slotIdx, c.id);
                                  setOpenColorSlotIdx(null);
                                }}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <select
                      id={localIdx === 0 ? 'profile-select' : `profile-select-${localIdx}`}
                      value={slot.profile}
                      title={slotMeta.summary}
                      onChange={(e) => routing.setSlotProfile(slotIdx, e.target.value as ProfileName)}
                    >
                      {(slot.profile === 'custom:__draft__' || routing.customProfiles.length > 0) && (
                        <optgroup label="Custom Profiles">
                          {slot.profile === 'custom:__draft__' && (
                            <option value="custom:__draft__">{slotMeta.label}</option>
                          )}
                          {routing.customProfiles.map((cp) => (
                            <option key={cp.id} value={cp.id}>
                              {routing.getProfileMeta(cp.id).label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Built-in Profiles">
                        {PROFILE_ORDER.map((key) => (
                          <option key={key} value={key}>
                            {PROFILE_INFO[key].label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    {activeRouteSlots.length > 1 && (
                      <button
                        id={`btn-remove-profile-${localIdx}`}
                        type="button"
                        className="wp-btn wp-btn-remove profile-slot-remove"
                        title="Remove compared profile"
                        aria-label={`Remove profile ${localIdx + 1}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          routing.removeProfileSlot(slotIdx);
                        }}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="waypoints-section">
            <div className="waypoints-top-bar">
              <div className="waypoints-top-left">
                <span className="waypoints-heading">Waypoints</span>
              </div>

              <div className="route-toolbar-group">
                <input
                  ref={importFileInputRef}
                  type="file"
                  id="input-import-gpx"
                  accept=".gpx"
                  style={{ display: 'none' }}
                  onChange={handleImportFileChange}
                />
                <button
                  id="btn-import-gpx"
                  type="button"
                  className="btn-toolbar-mini"
                  title="Upload GPX as editable route"
                  aria-label="Upload GPX"
                  onClick={() => importFileInputRef.current?.click()}
                >
                  <Icon name="upload" size={12} />
                  <span>Upload GPX</span>
                </button>
                <button
                  id="btn-undo"
                  type="button"
                  className="btn-toolbar-mini btn-toolbar-ghost"
                  title="Undo (Cmd+Z / Ctrl+Z)"
                  aria-label="Undo"
                  disabled={!routing.canUndo}
                  onClick={routing.undo}
                >
                  <Icon name="undo" size={13} />
                </button>
                <button
                  id="btn-redo"
                  type="button"
                  className="btn-toolbar-mini btn-toolbar-ghost"
                  title="Redo (Cmd+Shift+Z / Ctrl+Y)"
                  aria-label="Redo"
                  disabled={!routing.canRedo}
                  onClick={routing.redo}
                >
                  <Icon name="redo" size={13} />
                </button>
                <button
                  id="btn-clear-route"
                  type="button"
                  className="btn-toolbar-mini btn-toolbar-clear"
                  title="Clear route and avoid areas"
                  aria-label="Clear route"
                  disabled={routing.waypoints.length === 0 && routing.avoidAreas.length === 0}
                  onClick={routing.clearRoute}
                >
                  <Icon name="trash" size={12} />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <WaypointList
              waypoints={routing.waypoints}
              avoidAreas={routing.avoidAreas}
              isOfflineMode={offline.isOfflineMode}
              editingWaypointIndex={editingWaypointIndex}
              onClearEditingWaypoint={onClearEditingWaypoint}
              getMapCenter={getMapCenter}
              onSetWaypointAt={handleSetWaypointAt}
              onUseMyLocationAt={handleUseMyLocationAt}
              onReorder={routing.reorderWaypoints}
              onReverse={routing.reverseRoute}
              onRemove={routing.removeWaypoint}
              onRename={routing.renameWaypoint}
              onRemoveAvoidArea={routing.removeAvoidArea}
              onUpdateAvoidAreaRadius={routing.updateAvoidAreaRadius}
              onClearAvoidAreas={routing.clearAvoidAreas}
              onFlyTo={onFlyTo}
            />
          </div>
        </div>

        <div className="route-section-footer">
          <div
            id="status"
            className={`status-bar ${isBusy ? 'is-busy' : ''} ${routing.isError ? 'is-error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {isBusy && <span className="status-spinner" aria-hidden="true" />}
            {routing.status && <span className="status-text">{routing.status}</span>}
          </div>

          <div className="route-primary-actions">
            <button
              id="btn-share"
              type="button"
              className="btn btn-outline btn-action-compact"
              title="Copy shareable route link"
              disabled={!routing.slots.some((s) => s.waypoints.length >= 2)}
              onClick={handleShare}
            >
              <Icon name={shareCopied ? 'check' : 'share'} size={13} />
              <span>{shareCopied ? 'Copied' : 'Share'}</span>
            </button>

            <button
              id="btn-export-gpx"
              type="button"
              className="btn btn-primary btn-action-compact"
              title={
                routing.slots.length > 1
                  ? `Download Route ${routing.activeSlotIdx + 1} as GPX file`
                  : 'Download route as GPX file'
              }
              disabled={!routing.currentRoute}
              onClick={handleExportGpx}
            >
              <Icon name="download" size={13} />
              <span>Export GPX</span>
            </button>
          </div>
        </div>
      </div>

      {!isCollapsed && isProfileEditorOpen && (
        <ProfileEditorPanel routing={routing} onClose={onToggleProfileEditor} />
      )}
    </div>
  );
};

import { Activity, ArrowUpRight, BookOpenText, Brain, CalendarDays, Check, Link2, LockKeyhole, Power } from 'lucide-react'

import type { PluginPermission } from '../shared/types'
import { PLUGIN_PERMISSION_LABELS, TRUSTED_PLUGIN_REGISTRY } from './registry'

interface PluginCatalogViewProps {
  enabledPluginIds: string[]
  activePluginId: string | null
  pluginGrants: Record<string, PluginPermission[]>
  onOpen: (pluginId: string) => void
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>
}

export function PluginCatalogView(props: PluginCatalogViewProps): React.JSX.Element {
  const iconFor = (id: string): typeof CalendarDays => id === 'planner'
    ? CalendarDays
    : id === 'daily-notes'
      ? BookOpenText
      : id === 'flashcards'
        ? Brain
        : id === 'backlinks'
          ? Link2
          : Activity
  return (
    <div className="plugin-catalog">
      <div className="plugin-catalog__intro">
        <span className="plugin-catalog__intro-icon"><LockKeyhole size={16} /></span>
        <div>
          <strong>可信内置插件</strong>
          <p>当前版本不下载或执行第三方代码。清单与权限边界已为后续签名插件市场预留。</p>
        </div>
      </div>
      <div className="plugin-catalog__list">
        {TRUSTED_PLUGIN_REGISTRY.map((plugin) => {
          const enabled = props.enabledPluginIds.includes(plugin.id)
          const grants = props.pluginGrants[plugin.id] ?? []
          const permissionReady = plugin.permissions.every((permission) => grants.includes(permission))
          const allPermissions = [...plugin.permissions, ...(plugin.optionalPermissions ?? [])]
          const fullyGranted = allPermissions.every((permission) => grants.includes(permission))
          const supported = !plugin.platforms || plugin.platforms.includes(window.coscribe.app.platform as 'darwin' | 'win32' | 'linux')
          const active = props.activePluginId === plugin.id
          const Icon = iconFor(plugin.id)
          return (
            <article className={`plugin-card ${active ? 'is-active' : ''}`} key={plugin.id}>
              <header>
                <span className="plugin-card__icon"><Icon size={20} /></span>
                <div><strong>{plugin.name}</strong><small>内置 · v{plugin.version}</small></div>
                <button
                  className={`plugin-toggle ${enabled ? 'is-enabled' : ''}`}
                  type="button"
                  aria-pressed={enabled}
                  disabled={!supported}
                  aria-label={`${enabled && fullyGranted ? '停用' : enabled ? '补充授权' : '启用并授权'}${plugin.name}`}
                  title={!supported ? '当前系统不支持' : `${enabled && fullyGranted ? '停用' : enabled ? '补充授权' : '启用并授权'}${plugin.name}`}
                  onClick={() => void props.onToggle(plugin.id, !(enabled && fullyGranted))}
                >
                  <Power size={13} />
                </button>
              </header>
              <p>{plugin.description}</p>
              <ul>{plugin.features.map((feature) => <li key={feature}><Check size={12} />{feature}</li>)}</ul>
              <div className="plugin-card__permissions" aria-label="插件权限">{allPermissions.map((permission) => <span key={permission} className={grants.includes(permission) ? 'is-granted' : ''}>{PLUGIN_PERMISSION_LABELS[permission]}{plugin.optionalPermissions?.includes(permission) ? ' · 可选' : ''}</span>)}</div>
              <button className="plugin-card__open" type="button" disabled={!enabled || !permissionReady || !supported} onClick={() => props.onOpen(plugin.id)}>
                {!supported ? '仅支持 macOS' : !permissionReady ? '需要基础授权' : active ? '正在使用' : enabled && !fullyGranted ? '打开插件 · 可补充权限' : enabled ? '打开插件' : '启用后可用'}
                {enabled && permissionReady && supported && <ArrowUpRight size={14} />}
              </button>
            </article>
          )
        })}
      </div>
      <p className="plugin-catalog__footnote">后续市场插件将采用签名包、显式权限与独立沙箱；不会直接获得 Node.js 或项目任意路径权限。</p>
    </div>
  )
}

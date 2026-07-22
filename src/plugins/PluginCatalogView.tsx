import { ArrowUpRight, CalendarDays, Check, LockKeyhole, Power } from 'lucide-react'

import { TRUSTED_PLUGIN_REGISTRY } from './registry'

interface PluginCatalogViewProps {
  enabledPluginIds: string[]
  activePluginId: string | null
  onOpen: (pluginId: string) => void
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>
}

export function PluginCatalogView(props: PluginCatalogViewProps): React.JSX.Element {
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
          const active = props.activePluginId === plugin.id
          return (
            <article className={`plugin-card ${active ? 'is-active' : ''}`} key={plugin.id}>
              <header>
                <span className="plugin-card__icon"><CalendarDays size={20} /></span>
                <div><strong>{plugin.name}</strong><small>内置 · v{plugin.version}</small></div>
                <button
                  className={`plugin-toggle ${enabled ? 'is-enabled' : ''}`}
                  type="button"
                  aria-pressed={enabled}
                  aria-label={`${enabled ? '停用' : '启用'}${plugin.name}`}
                  title={`${enabled ? '停用' : '启用'}${plugin.name}`}
                  onClick={() => void props.onToggle(plugin.id, !enabled)}
                >
                  <Power size={13} />
                </button>
              </header>
              <p>{plugin.description}</p>
              <ul>{plugin.features.map((feature) => <li key={feature}><Check size={12} />{feature}</li>)}</ul>
              <button className="plugin-card__open" type="button" disabled={!enabled} onClick={() => props.onOpen(plugin.id)}>
                {active ? '正在使用' : enabled ? '打开插件' : '启用后可用'}
                {enabled && <ArrowUpRight size={14} />}
              </button>
            </article>
          )
        })}
      </div>
      <p className="plugin-catalog__footnote">后续市场插件将采用签名包、显式权限与独立沙箱；不会直接获得 Node.js 或项目任意路径权限。</p>
    </div>
  )
}

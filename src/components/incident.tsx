import { useState } from 'react';
import type { Incident, User, Role } from '../../shared/types.js';
import { ROLE_LABEL } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, INCIDENT_TYPE_LABEL, INCIDENT_STATUS_LABEL, fmtDateTime, useNotify } from '../ui.js';

const ROLE_BADGE: Record<Role, string> = {
  resident: 'gray', frontdesk: 'info', lifeguard: 'ok', cleaner: 'warn', maintenance: 'purple', ops: 'danger',
};

export function IncidentCard({ incident, user, onClose }: { incident: Incident; user: User; onClose?: () => void }) {
  const act = useAction();
  const notify = useNotify();
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);

  const run = (path: string, body?: unknown) =>
    act.mutateAsync({ path, body }).then(() => notify.ok('已同步到同场次所有角色')).catch((e) => notify.err(e));

  const undone = incident.tasks.filter((t) => !t.done).length;

  return (
    <div className={`incident ${incident.severity === 'critical' ? 'critical' : ''}`}>
      <div className="incident-head">
        <div className="flex">
          <Badge tone={incident.severity === 'critical' ? 'danger' : 'warn'}>
            {incident.severity === 'critical' ? '紧急' : '较大'}
          </Badge>
          <b style={{ fontSize: 14.5 }}>{INCIDENT_TYPE_LABEL[incident.type]} #{incident.code}</b>
          <Badge tone={incident.status === 'resolved' ? 'ok' : incident.status === 'responding' ? 'warn' : 'danger'}>
            {INCIDENT_STATUS_LABEL[incident.status]}
          </Badge>
        </div>
        <span className="small muted">{incident.reporter} 上报 · {fmtDateTime(incident.reportedAt)}</span>
      </div>
      <div className="incident-body">
        <div style={{ marginBottom: 8 }}><b>{incident.title}</b></div>
        <div className="small muted" style={{ marginBottom: 10 }}>{incident.description}</div>

        <div className="small muted" style={{ margin: '8px 0 4px' }}>
          跨角色协同处置清单 {undone === 0 ? '（已全部完成）' : `（${undone} 项待完成）`}
        </div>
        {incident.tasks.map((task) => {
          const canDo = !task.done && (task.role === user.role || user.role === 'ops');
          return (
            <div key={task.id} className={`task-row ${task.done ? 'done' : ''}`}>
              <span className="role-tag"><Badge tone={ROLE_BADGE[task.role]}>{ROLE_LABEL[task.role]}</Badge></span>
              <div style={{ flex: 1 }}>
                <div className="content">{task.content}</div>
                {task.done && <div className="small muted">✓ {task.doneBy} · {fmtDateTime(task.doneAt)}</div>}
              </div>
              {canDo && (
                <button className="btn sm ghost" disabled={act.isPending}
                  onClick={() => run(`/incidents/${incident.id}/tasks/${task.id}/done`)}>
                  完成
                </button>
              )}
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input placeholder="记录处置进展（全角色可见）…" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                run(`/incidents/${incident.id}/action`, { content: text.trim() }).then(() => setText(''));
              }
            }} />
          <button className="btn sm" disabled={!text.trim() || act.isPending}
            onClick={() => run(`/incidents/${incident.id}/action`, { content: text.trim() }).then(() => setText(''))}>
            上报进展
          </button>
          {user.role === 'ops' && incident.status !== 'resolved' && (
            <button className="btn sm danger" disabled={act.isPending}
              onClick={() => {
                if (undone > 0 && !confirm(`还有 ${undone} 项处置未完成，确认强制关闭事件？`)) return;
                run(`/incidents/${incident.id}/resolve`, { force: undone === 0 ? false : true, summary: '运营确认事件关闭' }).then(() => onClose?.());
              }}>
              关闭事件
            </button>
          )}
        </div>

        <div style={{ marginTop: 10 }}>
          <button className="btn sm ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : '查看'}处置记录（{incident.actions.length}）
          </button>
          {showAll && (
            <ul className="timeline" style={{ marginTop: 10 }}>
              {incident.actions.map((a) => (
                <li key={a.id} className={a.content.startsWith('完成') ? 'ok' : a.content.includes('闭池') ? 'danger' : ''}>
                  <div><b>{a.by}</b> <span className="badge gray">{ROLE_LABEL[a.byRole]}</span></div>
                  <div className="small">{a.content}</div>
                  <div className="at">{fmtDateTime(a.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function IncidentCreateForm({ sessions, defaultSessionId }: { sessions: AppState['sessions']; defaultSessionId?: string }) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(defaultSessionId ?? sessions[0]?.id);
  const [type, setType] = useState<Incident['type']>('cramp');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');

  return (
    <Card title="🚨 发起跨角色协同事件">
      <div className="form-row">
        <label className="field">关联场次
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">事件类型
          <select value={type} onChange={(e) => setType(e.target.value as Incident['type'])}>
            {Object.entries(INCIDENT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <div style={{ height: 10 }} />
      <label className="field">事件标题（可留空，使用类型默认标题）<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`如：${INCIDENT_TYPE_LABEL[type]}处置`} /></label>
      <div style={{ height: 10 }} />
      <label className="field">情况说明<textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="位置、人员、当前状况…" /></label>
      <div style={{ height: 10 }} />
      <button className="btn danger" disabled={!desc.trim() || act.isPending}
        onClick={() => act.mutateAsync({ path: '/incidents', body: { sessionId, type, title: title || undefined, description: desc } })
          .then(() => { notify.ok('事件已立案，处置任务已分派到各角色'); setDesc(''); setTitle(''); })
          .catch((e) => notify.err(e))}>
        立案并通知前台/救生/保洁/维修/运营
      </button>
      <div className="small muted" style={{ marginTop: 8 }}>
        立案后系统按事件类型自动生成各岗位处置清单；涉及保洁、维修的事项会自动转成他们的工单。
      </div>
    </Card>
  );
}

export function IncidentList({ incidents, user, empty = '当前场次暂无进行中的协同事件' }: {
  incidents: Incident[]; user: User; empty?: string;
}) {
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const list = incidents.filter((i) => tab === 'open' ? i.status !== 'resolved' : i.status === 'resolved');
  return (
    <div>
      <div className="tabs">
        <button className={`tab ${tab === 'open' ? 'active' : ''}`} onClick={() => setTab('open')}>
          处置中 {incidents.filter((i) => i.status !== 'resolved').length}
        </button>
        <button className={`tab ${tab === 'resolved' ? 'active' : ''}`} onClick={() => setTab('resolved')}>
          已关闭 {incidents.filter((i) => i.status === 'resolved').length}
        </button>
      </div>
      {list.length === 0 ? <div className="empty">{empty}</div> : list.map((i) => <IncidentCard key={i.id} incident={i} user={user} />)}
    </div>
  );
}

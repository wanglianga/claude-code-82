import { useState } from 'react';
import type { User, Notification } from '../../shared/types.js';
import { fmtDateTime } from '../ui.js';

export function visibleNotifications(user: User, all: Notification[]) {
  return all.filter((n) =>
    n.roles.length === 0 || n.roles.includes(user.role) || n.userId === user.id,
  );
}

export function NotifyBell({ user, notifications }: { user: User; notifications: Notification[] }) {
  const [open, setOpen] = useState(false);
  const list = visibleNotifications(user, notifications).slice(0, 30);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>
        🔔 通告 {list.length > 0 && <span className="badge danger">{list.length}</span>}
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setOpen(false)} />
          <div className="card" style={{ position: 'absolute', right: 0, top: 40, width: 380, maxHeight: 480, overflowY: 'auto', zIndex: 21, padding: 12 }}>
            <b style={{ color: 'var(--deep)' }}>现场通告</b>
            <div style={{ height: 8 }} />
            {list.length === 0 && <div className="empty">暂无通告</div>}
            {list.map((n) => (
              <div key={n.id} className={`notif ${n.level}`}>
                <div className="flex"><b>{n.title}</b><span className="spacer" /><span className="nt">{fmtDateTime(n.at)}</span></div>
                <div className="small" style={{ marginTop: 3 }}>{n.body}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

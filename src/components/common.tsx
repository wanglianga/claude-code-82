import React from 'react';
import type { Session, LiveBoard, PoolStatus } from '../../shared/types.js';
import type { AppState } from '../api.js';
import { Badge, POOL_STATUS_LABEL, POOL_STATUS_BADGE } from '../ui.js';

export function boardFor(state: AppState, sessionId: string): LiveBoard {
  return state.boards.find((b) => b.session.id === sessionId) ?? state.boards[0];
}

export function SessionPicker({ sessions, value, onChange }: {
  sessions: Session[]; value: string; onChange: (id: string) => void;
}) {
  return (
    <div className="tabs">
      {sessions.map((s) => (
        <button key={s.id} className={`tab ${value === s.id ? 'active' : ''}`} onClick={() => onChange(s.id)}>
          {s.label}
          {s.poolStatus !== 'normal' && (
            <span className={`badge ${POOL_STATUS_BADGE[s.poolStatus]}`} style={{ marginLeft: 6 }}>
              {POOL_STATUS_LABEL[s.poolStatus]}
            </span>
          )}
          {s.publicWelfare && <span className="badge purple" style={{ marginLeft: 6 }}>公益</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ num, label, tone }: { num: React.ReactNode; label: string; tone?: '' | 'accent' | 'warn' | 'danger' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="num">{num}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

/** 场次生命周期：预约 → 入场 → 巡查 → 事件处置 → 闭池清场 → 恢复 */
export function LifecycleSteps({ session, stage }: { session: Session; stage: 'booking' | 'live' | 'cleared' | 'closed' }) {
  const idx = stage === 'booking' ? 0 : stage === 'live' ? 2 : stage === 'closed' ? 4 : 5;
  const closed = session.poolStatus === 'closed';
  const restricted = session.poolStatus === 'restricted';
  const steps = [
    { label: '居民预约', },
    { label: '前台核验入场' },
    { label: '在池·救生巡查' },
    { label: restricted ? '异常限流处置' : '异常事件处置' },
    { label: closed ? '闭池联动（退费/复测/通知）' : '清场' },
    { label: '复测合格·恢复开放' },
  ];
  return (
    <div className="flow-steps">
      {steps.map((s, i) => (
        <div key={i} className={`flow-step ${i === idx ? 'on' : ''} ${i < idx ? 'done' : ''}`}>
          <span className="n">{i < idx ? '✓' : i + 1}</span>{s.label}
        </div>
      ))}
    </div>
  );
}

export function PoolStatusBanner({ status, reason, requireRetest, closedAt, reopenedAt }: {
  status: PoolStatus; reason?: string; requireRetest?: boolean; closedAt?: string; reopenedAt?: string;
}) {
  if (status === 'normal') {
    return reopenedAt
      ? <div className="alert ok">✅ 已恢复开放（{new Date(reopenedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）：水质复测合格，退费/补偿/通知均已落账，居民端与现场端状态一致。</div>
      : null;
  }
  if (status === 'restricted')
    return <div className="alert warn">⚠️ 限流通告：{reason || '现场异常'}。新入场已暂停，在池泳客岸上观察；{requireRetest ? '维修处置后须复测达标。' : ''}</div>;
  return (
    <div className="alert danger">
      🚫 本场已闭池：{reason}
      {requireRetest && <div style={{ marginTop: 4 }}>恢复开放前置条件：维修完成消毒处置 + 救生员录入一次达标水质复测。</div>}
      {closedAt && <div className="small" style={{ marginTop: 4 }}>闭池时间 {new Date(closedAt).toLocaleString('zh-CN', { hour12: false })}</div>}
    </div>
  );
}

export { Badge };

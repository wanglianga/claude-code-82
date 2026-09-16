import { useState } from 'react';
import type {
  CrampRescue, CrampPart, RescueMethod, RescueClosureKey, User, ZoneId,
} from '../../shared/types.js';
import {
  CRAMP_PART_LABEL, RESCUE_METHOD_LABEL, RESCUE_CLOSURE_LABEL,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import { Badge, Card, Empty, fmtDateTime, useNotify } from '../ui.js';
import { SessionPicker } from './common.js';

const PARTS = Object.keys(CRAMP_PART_LABEL) as CrampPart[];
const METHODS = Object.keys(RESCUE_METHOD_LABEL) as RescueMethod[];
const CLOSURE_KEYS = Object.keys(RESCUE_CLOSURE_LABEL) as RescueClosureKey[];

export function zoneLabel(state: AppState, zoneId: ZoneId) {
  return state.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
}

/** 救援状态：临停中 → 待收尾 → 待复盘 → 已复盘 */
export function rescueStatus(r: CrampRescue): { tone: 'danger' | 'warn' | 'purple' | 'ok'; text: string } {
  if (r.laneSuspended) return { tone: 'danger', text: '泳道临停中' };
  const pending = CLOSURE_KEYS.filter((k) => !r.closure[k].done);
  if (pending.length) return { tone: 'warn', text: `收尾待确认（${pending.length}）` };
  if (!r.reviewedAt) return { tone: 'purple', text: '待本场复盘' };
  return { tone: 'ok', text: '已复盘' };
}

// ============ 救生员：新救援记录表单 ============
export function RescueCreateForm({ state, sessionId, setSessionId }: {
  state: AppState; sessionId: string; setSessionId: (s: string) => void;
}) {
  const act = useAction();
  const notify = useNotify();
  const [zoneId, setZoneId] = useState<ZoneId>('training');
  const [lane, setLane] = useState(3);
  const [part, setPart] = useState<CrampPart>('calf');
  const [method, setMethod] = useState<RescueMethod>('wading');
  const [patron, setPatron] = useState('');
  const [treatment, setTreatment] = useState('');
  const [family, setFamily] = useState(false);
  const [familyNote, setFamilyNote] = useState('');
  const [medical, setMedical] = useState(false);
  const [medicalNote, setMedicalNote] = useState('');

  const submit = () => {
    if (!patron.trim() || !treatment.trim()) { notify.err('请填写泳客描述与上岸处理'); return; }
    act.mutateAsync({
      path: '/cramp-rescues',
      body: {
        sessionId, zoneId, lane, crampPart: part, patronDesc: patron, method,
        shoreTreatment: treatment, familyContacted: family, familyNote: family || familyNote ? familyNote : undefined,
        medicalAdvised: medical, medicalNote: medical || medicalNote ? medicalNote : undefined,
      },
    }).then((r: any) => {
      notify.ok(`救援记录 ${r.code} 已登记，泳道临停并自动立案`);
      setPatron(''); setTreatment(''); setFamily(false); setFamilyNote(''); setMedical(false); setMedicalNote('');
    }).catch((e) => notify.err(e));
  };

  const suspended = state.boards.find((b) => b.session.id === sessionId)?.suspendedLanes ?? [];

  return (
    <Card title="🆘 抽筋救援记录（发现时间 · 救援方式 · 上岸处理 · 家属 · 就医）">
      <div className="form-row">
        <label className="field">发生场次
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {state.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">泳区
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value as ZoneId)}>
            {state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
      </div>
      <div style={{ height: 10 }} />
      <div className="form-row">
        <label className="field">抽筋泳道
          <select value={lane} onChange={(e) => setLane(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
              const hit = suspended.find((l) => l.zoneId === zoneId && l.lane === n);
              return <option key={n} value={n} disabled={!!hit}>{n} 号道{hit ? '（临停中）' : ''}</option>;
            })}
          </select>
        </label>
        <label className="field">抽筋部位
          <select value={part} onChange={(e) => setPart(e.target.value as CrampPart)}>
            {PARTS.map((p) => <option key={p} value={p}>{CRAMP_PART_LABEL[p]}</option>)}
          </select>
        </label>
      </div>
      <div style={{ height: 10 }} />
      <label className="field">救援方式
        <select value={method} onChange={(e) => setMethod(e.target.value as RescueMethod)}>
          {METHODS.map((m) => <option key={m} value={m}>{RESCUE_METHOD_LABEL[m]}</option>)}
        </select>
      </label>
      <div style={{ height: 10 }} />
      <label className="field">被救泳客描述（柜号/性别/大致年龄/会员特征，用于家属联系与复盘）
        <input value={patron} onChange={(e) => setPatron(e.target.value)} placeholder="如：男泳客约 60 岁，柜 B03，自称晨泳老人" />
      </label>
      <div style={{ height: 10 }} />
      <label className="field">上岸处理（拉伸/保暖/观察/AED 等）
        <textarea value={treatment} onChange={(e) => setTreatment(e.target.value)} placeholder="如：搀扶上岸，坐姿伸展小腿，热敷保暖，岸边观察 20 分钟…" />
      </label>
      <div style={{ height: 10 }} />
      <div className="form-row">
        <label className="checkbox"><input type="checkbox" checked={family} onChange={(e) => setFamily(e.target.checked)} /> 已联系家属</label>
        <label className="checkbox"><input type="checkbox" checked={medical} onChange={(e) => setMedical(e.target.checked)} /> 建议就医 / 已呼叫 120</label>
      </div>
      {family && (
        <label className="field" style={{ marginTop: 8 }}>家属联系情况<input value={familyNote} onChange={(e) => setFamilyNote(e.target.value)} placeholder="如：电话告知其子，家属到馆接送" /></label>
      )}
      {medical && (
        <label className="field" style={{ marginTop: 8 }}>就医处置情况<textarea value={medicalNote} onChange={(e) => setMedicalNote(e.target.value)} placeholder="如：已拨打 120，前台开门引导救护车，送医时生命体征…" /></label>
      )}
      <div style={{ height: 12 }} />
      <button className="btn danger" disabled={act.isPending} onClick={submit}>登记救援并临停该泳道</button>
      <div className="small muted" style={{ marginTop: 8 }}>
        登记后自动：① 该泳道临时关闭（居民不可预约/前台不可放行到该道）；② 立案「泳客抽筋」协同事件通知前台/保洁/运营；
        ③ 救援结束须逐项确认<b>救生员换岗、泳道临停解除、水面秩序恢复</b>；④ 站位调整后下一场救生巡查自动提醒重点关注同一泳道。
      </div>
    </Card>
  );
}

// ============ 单条救援记录：三确认 + 站位调整 ============
export function RescueCard({ rescue, state, user }: { rescue: CrampRescue; state: AppState; user: User }) {
  const act = useAction();
  const notify = useNotify();
  const guards = state.users.filter((u) => u.role === 'lifeguard');
  const [relief, setRelief] = useState(guards.find((g) => g.name !== rescue.guardName)?.name ?? '');
  const [reliefNote, setReliefNote] = useState('');
  const [adjust, setAdjust] = useState(
    `加强${zoneLabel(state, rescue.zoneId)} ${rescue.lane} 号道瞭望，加派机动巡视，提醒泳客下水前热身`,
  );
  const [propagate, setPropagate] = useState(true);

  const run = (path: string, body?: unknown, ok?: string) =>
    act.mutateAsync({ path, body }).then(() => notify.ok(ok ?? '已确认并同步各角色')).catch((e) => notify.err(e));

  const st = rescueStatus(rescue);
  const canManage = user.role === 'lifeguard' || user.role === 'ops';

  return (
    <div className={`incident ${rescue.laneSuspended ? 'critical' : ''}`}>
      <div className="incident-head">
        <div className="flex">
          <b style={{ fontSize: 14.5 }}>🆘 {rescue.code}</b>
          <Badge tone={st.tone}>{st.text}</Badge>
          {rescue.medicalAdvised && <Badge tone="danger">已建议就医</Badge>}
        </div>
        <span className="small muted">{fmtDateTime(rescue.foundAt)} 发现 · {rescue.guardName}</span>
      </div>
      <div className="incident-body">
        <div className="small" style={{ marginBottom: 6 }}>
          <b>{zoneLabel(state, rescue.zoneId)} {rescue.lane} 号道</b> · {CRAMP_PART_LABEL[rescue.crampPart]}抽筋 · {RESCUE_METHOD_LABEL[rescue.method]}
        </div>
        <dl className="kv small">
          <dt>被救泳客</dt><dd>{rescue.patronDesc}</dd>
          <dt>上岸处理</dt><dd>{rescue.shoreTreatment}</dd>
          <dt>联系家属</dt><dd>{rescue.familyContacted ? `已联系${rescue.familyNote ? `：${rescue.familyNote}` : ''}` : '未联系'}</dd>
          <dt>建议就医</dt><dd>{rescue.medicalAdvised ? `已建议就医${rescue.medicalNote ? `：${rescue.medicalNote}` : ''}` : '未建议（岸边观察后恢复）'}</dd>
        </dl>

        {/* 收尾三项确认 */}
        <div className="small muted" style={{ margin: '10px 0 4px' }}>救援结束收尾确认（缺项不能进入本场复盘）</div>
        {CLOSURE_KEYS.map((k) => {
          const c = rescue.closure[k];
          return (
            <div key={k} className={`task-row ${c.done ? 'done' : ''}`}>
              <div style={{ flex: 1 }}>
                <div className="content">{RESCUE_CLOSURE_LABEL[k]}</div>
                {c.done
                  ? <div className="small muted">✓ {c.by} · {fmtDateTime(c.at)}{c.note ? ` · ${c.note}` : ''}</div>
                  : k === 'guard_relief' && canManage ? (
                    <div className="flex" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
                      <select value={relief} onChange={(e) => setRelief(e.target.value)} style={{ width: 130 }}>
                        <option value="">线下换岗…</option>
                        {guards.filter((g) => g.name !== rescue.guardName).map((g) => <option key={g.id}>{g.name}</option>)}
                      </select>
                      <input style={{ flex: 1, minWidth: 160 }} placeholder="换岗说明（如：施救后陪同泳客观察）"
                        value={reliefNote} onChange={(e) => setReliefNote(e.target.value)} />
                      <button className="btn sm" disabled={act.isPending}
                        onClick={() => run(`/cramp-rescues/${rescue.id}/closure/guard_relief`, { relief: relief || undefined, note: reliefNote || undefined },
                          relief ? `换岗完成：${relief} 已接替同一站位` : '线下换岗已确认')}>
                        确认换岗
                      </button>
                    </div>
                  ) : null}
              </div>
              {c.done ? <Badge tone="ok">已确认</Badge>
                : canManage && k !== 'guard_relief' && (
                  <button className="btn sm ghost" disabled={act.isPending}
                    onClick={() => run(`/cramp-rescues/${rescue.id}/closure/${k}`)}>确认</button>
                )}
            </div>
          );
        })}

        {/* 站位调整 */}
        <div className="small muted" style={{ margin: '12px 0 4px' }}>救生员站位调整（影响本场复盘与后续场次巡查重点）</div>
        {rescue.adjustments.length === 0 && <div className="small muted">尚未记录站位调整</div>}
        {rescue.adjustments.map((a) => (
          <div key={a.version} className="small" style={{ padding: '4px 0' }}>
            <span className="badge purple">第{a.version}版</span> {a.content} <span className="muted">（{a.by} · {fmtDateTime(a.at)}）</span>
          </div>
        ))}
        {canManage && (
          <div style={{ marginTop: 6 }}>
            <textarea value={adjust} onChange={(e) => setAdjust(e.target.value)} />
            <div className="flex" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
              <label className="checkbox" style={{ margin: 0 }}>
                <input type="checkbox" checked={propagate} onChange={(e) => setPropagate(e.target.checked)} />
                同步为下一场起救生巡查重点关注该泳道
              </label>
              <button className="btn sm" disabled={act.isPending || !adjust.trim()}
                onClick={() => run(`/cramp-rescues/${rescue.id}/adjust`, { content: adjust, propagateToNextSessions: propagate },
                  propagate ? '站位调整已记录，后续场次将重点关注该泳道' : '站位调整已记录')}>
                记录站位调整
              </button>
            </div>
          </div>
        )}

        {/* 复盘结果 */}
        {rescue.reviewedAt && (
          <div className="alert ok" style={{ marginTop: 10 }}>
            <b>本场复盘（{rescue.reviewedBy} · {fmtDateTime(rescue.reviewedAt)}）</b>
            <div className="small" style={{ marginTop: 4 }}>{rescue.reviewSummary}</div>
            <div className="small" style={{ marginTop: 4 }}>
              培训项 {rescue.trainingIds.length} 项{rescue.intoSchedule ? ' · 已进入近期救生排班' : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 看板顶部：下一场重点关注泳道提醒（展示最新版本策略） ============
export function FocusLaneAlerts({ state, sessionId }: { state: AppState; sessionId: string }) {
  const act = useAction();
  const notify = useNotify();
  const board = state.boards.find((b) => b.session.id === sessionId);
  const lanes = board?.focusLanes ?? [];
  if (lanes.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {lanes.map((f, i) => (
        <div key={i} className="alert warn" style={{ marginBottom: 6 }}>
          <div className="flex">
            <b>🛟 本场重点关注：{zoneLabel(state, f.zoneId)} {f.lane} 号道 <span className="badge purple" style={{ marginLeft: 4 }}>第 {f.version} 版策略</span></b>
            <span className="spacer" />
            {f.ackAt
              ? <Badge tone="ok">已确认关注 · {f.ackBy} {fmtDateTime(f.ackAt)}</Badge>
              : <button className="btn sm" disabled={act.isPending}
                  onClick={() => act.mutateAsync({
                    path: `/sessions/${sessionId}/focus-lanes/ack`,
                    body: { rescueId: f.rescueId, zoneId: f.zoneId, lane: f.lane },
                  }).then(() => notify.ok('已确认，本场巡查将按最新策略重点关注该泳道')).catch((e) => notify.err(e))}>
                救生巡查确认关注{f.history.length > 0 ? '（新版本，需重新确认）' : ''}
              </button>}
          </div>
          <div className="small" style={{ marginTop: 4 }}>{f.reason}</div>
          {f.updatedAt && <div className="small muted">策略更新于 {fmtDateTime(f.updatedAt)} · {f.updatedBy}{f.history.length > 0 && !f.ackAt ? ' · 上一版确认已归档，需按新版重新确认' : ''}</div>}
          {f.history.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>历次策略与确认留痕（{f.history.length} 版）</summary>
              {f.history.map((h) => (
                <div key={h.version} className="small muted" style={{ marginTop: 2, paddingLeft: 8, borderLeft: '2px solid var(--border, #ddd)' }}>
                  第{h.version}版 · {fmtDateTime(h.at)}{h.by ? ` · ${h.by}` : ''}：{h.reason}
                  {h.ackAt ? ` · 该版已由 ${h.ackBy} 于 ${fmtDateTime(h.ackAt)} 确认（后被新版替换）` : ' · 该版未确认即被新版替换'}
                </div>
              ))}
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

// ============ 救生员：抽筋救援工作台 ============
export function RescueWorkbench({ state, user, sessionId, setSessionId }: {
  state: AppState; user: User; sessionId: string; setSessionId: (s: string) => void;
}) {
  const inSession = state.crampRescues.filter((r) => r.sessionId === sessionId);
  const history = state.crampRescues.filter((r) => r.sessionId !== sessionId);
  const myTraining = state.guardTraining;

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <FocusLaneAlerts state={state} sessionId={sessionId} />
      <div className="grid cols-2">
        <RescueCreateForm state={state} sessionId={sessionId} setSessionId={setSessionId} />
        <Card title={`本场救援记录（${inSession.length}）`}>
          {inSession.length === 0 ? <Empty text="本场暂无抽筋救援记录" /> :
            inSession.map((r) => <div key={r.id} style={{ marginBottom: 12 }}><RescueCard rescue={r} state={state} user={user} /></div>)}
        </Card>
      </div>

      <div className="grid cols-2 section-gap">
        <Card title="复盘结论 → 救生员培训与排班">
          {myTraining.length === 0 ? <Empty text="暂无复盘培训项" /> : myTraining.map((t) => (
            <TrainingRow key={t.id} t={t} state={state} user={user} />
          ))}
        </Card>
        <Card title="历史场次救援记录">
          {history.length === 0 ? <Empty text="暂无历史记录" /> : history.map((r) => (
            <div key={r.id} className="queue-row">
              <div>
                <b className="small">{r.code} · {zoneLabel(state, r.zoneId)} {r.lane} 号道</b>
                <div className="small muted">
                  {state.sessions.find((s) => s.id === r.sessionId)?.label ?? r.sessionId} · {fmtDateTime(r.foundAt)} · {r.guardName}
                  {r.adjustments.length > 0 ? ` · 站位调整 ${r.adjustments.length} 次` : ''}
                  {r.reviewedAt ? ' · 已复盘' : ' · 待复盘'}
                </div>
              </div>
              <Badge tone={rescueStatus(r).tone}>{rescueStatus(r).text}</Badge>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/** 培训项行（救生员确认参训 / 运营标记完成共用） */
export function TrainingRow({ t, state, user }: { t: AppState['guardTraining'][number]; state: AppState; user: User }) {
  const act = useAction();
  const notify = useNotify();
  const rescue = t.sourceRescueId ? state.crampRescues.find((r) => r.id === t.sourceRescueId) : undefined;
  return (
    <div className={`notif ${t.done ? 'info' : 'warning'}`}>
      <div className="flex">
        <b className="small">{t.title}</b>
        <span className="spacer" />
        <Badge tone={t.done ? 'ok' : 'warn'}>{t.done ? '培训已完成' : '待培训'}</Badge>
      </div>
      <div className="small" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{t.content}</div>
      <div className="small muted">
        {t.sessionLabel} · 对象：{t.targetGuardNames.length ? t.targetGuardNames.join('、') : '全体救生员'} · {t.recordedBy} 复盘录入
        {t.intoSchedule && t.scheduleNote ? ` · 排班：${t.scheduleNote}` : ''}
        {rescue ? ` · 关联救援 ${rescue.code}` : ''}
      </div>
      {!t.done && (user.role === 'lifeguard' || user.role === 'ops') && (
        <button className="btn sm" style={{ marginTop: 6 }} disabled={act.isPending}
          onClick={() => act.mutateAsync({ path: `/guard-training/${t.id}/done`, body: { result: '已参加复盘培训并掌握处置要点' } })
            .then(() => notify.ok('参训情况已登记')).catch((e) => notify.err(e))}>
          {user.role === 'ops' ? '标记培训完成' : '登记参训完成'}
        </button>
      )}
    </div>
  );
}

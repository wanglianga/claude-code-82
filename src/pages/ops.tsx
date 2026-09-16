import { useMemo, useState } from 'react';
import type {
  User, Session, IncidentType, LockReason, ZoneId, TaskKind,
} from '../../shared/types.js';
import type { AppState } from '../api.js';
import { useAction } from '../api.js';
import {
  Badge, Card, Empty, KIND_LABEL, TIER_LABEL, BOOKING_STATUS_LABEL, BOOKING_STATUS_BADGE,
  POOL_STATUS_LABEL, POOL_STATUS_BADGE, INCIDENT_TYPE_LABEL, ISSUE_TYPE_LABEL,
  TASK_STATUS_LABEL, fmtDateTime, useNotify,
} from '../ui.js';
import { SessionPicker, LifecycleSteps, PoolStatusBanner, Stat } from '../components/common.js';
import { IncidentList, IncidentCreateForm } from '../components/incident.js';

type Props = { user: User; state: AppState; tab: string };

const userName = (state: AppState, id: string) => state.users.find((u) => u.id === id);

// ============ 场次指挥台 ============
function stageOf(s: Session): 'booking' | 'live' | 'cleared' | 'closed' {
  if (s.poolStatus === 'closed') return 'closed';
  const hm = new Date().toTimeString().slice(0, 5);
  if (hm < s.start) return 'booking';
  if (hm > s.end) return 'cleared';
  return 'live';
}

type TL = { at: string; title: string; tone?: '' | 'danger' | 'ok'; who: string };

function buildTimeline(state: AppState, sessionId: string): TL[] {
  const tl: TL[] = [];
  const s = state.sessions.find((x) => x.id === sessionId)!;
  for (const b of state.bookings.filter((b) => b.sessionId === sessionId)) {
    tl.push({ at: b.createdAt, title: `预约 ${b.code} · ${KIND_LABEL[b.kind]}（${userName(state, b.userId)?.name}）→ ${state.zones.find((z) => z.id === b.zoneId)?.name}`, who: '居民端' });
    if (b.checkedInAt) tl.push({ at: b.checkedInAt, title: `${b.code} 核验入场${b.lockerNo ? `，储物柜 ${b.lockerNo}` : ''}`, tone: 'ok', who: b.checkedInBy ?? '前台' });
    if (b.status === 'refunded' || b.status === 'compensated') tl.push({ at: b.checkedInAt ?? b.createdAt, title: `${b.code} 闭池联动${b.status === 'compensated' ? '退费+补偿券' : '退费'}`, tone: 'danger', who: '系统联动' });
    if (b.status === 'cancelled') tl.push({ at: b.createdAt, title: `${b.code} 取消`, who: '居民端' });
  }
  for (const w of state.waterReadings.filter((w) => w.sessionId === sessionId))
    tl.push({ at: w.at, title: `水质检测：${w.abnormal ? w.abnormalFields.join('；') : '达标'}（水温 ${w.tempC} / 余氯 ${w.freeChlorine} / 浊度 ${w.turbidity} / pH ${w.ph}）`, tone: w.abnormal ? 'danger' : 'ok', who: w.recorder });
  for (const p of state.patrolIssues.filter((p) => p.sessionId === sessionId))
    tl.push({ at: p.at, title: `巡查：${ISSUE_TYPE_LABEL[p.type]} @ ${p.location} — ${p.description}`, tone: p.severity === 'critical' ? 'danger' : '', who: `${p.reporter}→${p.assigneeName ?? ''}` });
  for (const i of state.incidents.filter((i) => i.sessionId === sessionId)) {
    tl.push({ at: i.reportedAt, title: `事件立案 #${i.code} ${INCIDENT_TYPE_LABEL[i.type]}：${i.title}`, tone: 'danger', who: i.reporter });
    if (i.resolvedAt) tl.push({ at: i.resolvedAt, title: `事件 #${i.code} 关闭`, tone: 'ok', who: '运营' });
  }
  for (const d of state.guardDuties.filter((d) => d.sessionId === sessionId)) {
    tl.push({ at: d.start, title: `救生员上哨：${userName(state, d.guardUserId)?.name} @ ${d.post}`, who: '救生端' });
    if (d.end) tl.push({ at: d.end, title: `救生员下哨/换岗${d.relief ? `：接班人 ${d.relief}` : ''}${d.note ? `（${d.note}）` : ''}`, tone: 'ok', who: '救生端' });
  }
  for (const t of state.workTasks.filter((t) => t.sessionId === sessionId && t.doneAt))
    tl.push({ at: t.doneAt!, title: `工单完成：${t.title} — ${t.result}`, tone: 'ok', who: t.assigneeName ?? '' });
  // 每一轮闭池都来自不可变档案：原因、退费补偿、清场、复测、通知结果各自固化，互不覆盖
  const closureRecords = state.closureRecords
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => a.seq - b.seq);
  for (const r of closureRecords) {
    tl.push({
      at: r.closedAt,
      title: `第${zh(r.seq)}轮闭池：${r.reason}（储值退 ${r.walletRefundCount} 笔/¥${r.walletRefundTotal}、原券返还 ${r.originalVoucherReturnCount} 张、现场退款登记 ${r.cashRefundCount} 笔/¥${r.cashRefundTotal}、额外补偿券 ${r.extraVoucherCount} 张、撤哨 ${r.guardReliefCount} 人、通知 ${r.announcementIds.length} 条、档案 ${r.id}）`,
      tone: 'danger', who: `${r.closedBy}·闭池档案`,
    });
    if (r.status === 'reopened' && r.reopenedAt) {
      tl.push({
        at: r.reopenedAt,
        title: `第${zh(r.seq)}轮闭池结束，恢复开放${r.retestReadingId ? '（依据达标复测 ' + r.retestReadingId + '）' : ''}`,
        tone: 'ok', who: `${r.reopenedBy ?? '运营'}·闭池档案`,
      });
    }
  }
  return tl.sort((a, b) => b.at.localeCompare(a.at));
}

function zh(n: number) {
  return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] ?? String(n);
}

/** 按原支付渠道描述退款/返还结果（财务结算与居民通知口径一致） */
function refundResultText(a: import('../../shared/types.js').ClosureAffectedItem) {
  if (!a.refunded || !a.refund) return '未退款';
  const r = a.refund;
  if (r.channel === 'wallet') return `已退储值 ¥${r.amount}`;
  if (r.channel === 'voucher') return `原补偿券已返还 ${r.returnedCount} 张（无金额流水）`;
  return r.amount > 0 ? `现场退款登记 ¥${r.amount}` : (r.note || '公益免费无需退款');
}

function Command({ state }: Props) {
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const session = state.sessions.find((s) => s.id === sessionId)!;
  const board = state.boards.find((b) => b.session.id === sessionId)!;
  const bookings = state.bookings.filter((b) => b.sessionId === sessionId);
  const issues = state.patrolIssues.filter((p) => p.sessionId === sessionId);
  const duties = state.guardDuties.filter((d) => d.sessionId === sessionId);
  const tasks = state.workTasks.filter((t) => t.sessionId === sessionId);
  const incs = state.incidents.filter((i) => i.sessionId === sessionId);
  const timeline = useMemo(() => buildTimeline(state, sessionId), [state, sessionId]);
  const stage = stageOf(session);

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <LifecycleSteps session={session} stage={stage} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Card><Stat num={bookings.filter((b) => b.status === 'booked').length} label="待入场预约" /></Card>
        <Card><Stat num={board.totalInPool} label="当前在池人数" tone="accent" /></Card>
        <Card><Stat num={issues.filter((p) => p.status !== 'resolved').length} label="未结巡查问题" tone={issues.some((p) => p.status !== 'resolved') ? 'warn' : ''} /></Card>
        <Card><Stat num={incs.filter((i) => i.status !== 'resolved').length} label="处置中事件" tone={incs.some((i) => i.status !== 'resolved') ? 'danger' : ''} /></Card>
      </div>

      <div className="grid cols-2">
        <Card title="泳区占用（含商业锁定）">
          {board.zones.map((z) => (
            <div key={z.zoneId} className={`zone-card ${z.zoneId === 'deep' ? 'risk-high' : ''}`} style={{ marginBottom: 10 }}>
              <div className="zone-head">
                <b>{z.name}</b>
                <span className="small muted">在池 {z.inPool} · 待入 {z.booked} · 锁 {z.locked} / 容量 {z.capacity}</span>
              </div>
              <div className="meter"><i className={z.occupancyPct > 85 ? 'hot' : ''} style={{ width: `${Math.min(100, z.occupancyPct)}%` }} /></div>
              <div className="small muted">儿童 {z.children} · 深水证持有者 {z.deepCertHoldersInPool} · 占用率 {z.occupancyPct}%</div>
            </div>
          ))}
          {session.locks.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <h4>本场锁定（商业/教学）</h4>
              {session.locks.map((l) => (
                <div key={l.id} className="queue-row">
                  <div><b>{l.title}</b><div className="small muted">{state.zones.find((z) => z.id === l.zoneId)?.name}{l.lane ? ` ${l.lane}号道` : '整区'} · {l.capacity}人 · {l.contactName} {l.contactPhone}</div></div>
                  <Badge tone={l.isCommercial ? 'danger' : 'purple'}>{l.isCommercial ? '商业' : '教学/公益'}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="本场完整时间线（预约→入场→巡查→清场）">
          {timeline.length === 0 ? <Empty text="暂无动态" /> : (
            <ul className="timeline">
              {timeline.map((t, i) => (
                <li key={i} className={t.tone === 'danger' ? 'danger' : t.tone === 'ok' ? 'ok' : ''}>
                  <div>{t.title}</div>
                  <div className="at">{fmtDateTime(t.at)} · {t.who}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid cols-2 section-gap">
        <Card title={`预约与入场明细（${bookings.length}）`}>
          {bookings.length === 0 ? <Empty text="暂无预约" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>码</th><th>泳客</th><th>类型</th><th>泳区</th><th>人数</th><th>状态</th><th>柜</th></tr></thead>
              <tbody>{bookings.map((b) => (
                <tr key={b.id}>
                  <td className="code-mono">{b.code}</td>
                  <td className="small">{userName(state, b.userId)?.name}<div className="muted">{TIER_LABEL[userName(state, b.userId)?.memberTier ?? 'normal']}</div></td>
                  <td className="small">{KIND_LABEL[b.kind]}</td>
                  <td className="small">{state.zones.find((z) => z.id === b.zoneId)?.name}{b.lane ? ` ${b.lane}号道` : ''}</td>
                  <td>{b.partySize}{b.childrenInParty ? `（童${b.childrenInParty}）` : ''}</td>
                  <td><Badge tone={BOOKING_STATUS_BADGE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge></td>
                  <td>{b.lockerNo ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <div className="grid">
          <Card title="救生站位">
            {duties.length === 0 ? <Empty text="暂无站位" /> : duties.map((d) => (
              <div key={d.id} className="queue-row">
                <div className="small">{userName(state, d.guardUserId)?.name} · {d.post} · {fmtDateTime(d.start)}{d.end ? ` 下哨${d.relief ? ` →${d.relief}` : ''}` : ' 在岗'}</div>
                {d.end ? <Badge tone="gray">已结束</Badge> : <Badge tone="ok">在岗</Badge>}
              </div>
            ))}
          </Card>
          <Card title="工单与巡查">
            {[...tasks, ...issues.map((p) => ({ kind: 'patrol' as const, title: `巡查：${ISSUE_TYPE_LABEL[p.type]}`, status: p.status === 'resolved' ? 'done' as const : 'pending' as const, detail: p.description, id: p.id }))].length === 0 ? <Empty text="暂无" /> : (
              <>
                {tasks.map((t) => (
                  <div key={t.id} className="queue-row">
                    <div className="small">[{t.kind === 'disinfection' ? '消毒' : t.kind === 'maintenance' ? '维修' : '保洁'}] {t.title}</div>
                    <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
                  </div>
                ))}
                {issues.map((p) => (
                  <div key={p.id} className="queue-row">
                    <div className="small">[巡查] {ISSUE_TYPE_LABEL[p.type]} @{p.location}</div>
                    <Badge tone={p.status === 'resolved' ? 'ok' : p.status === 'handling' ? 'warn' : 'danger'}>{p.status === 'resolved' ? '已处理' : p.status === 'handling' ? '处理中' : '待处理'}</Badge>
                  </div>
                ))}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ============ 商业 / 公益冲突 ============
function Conflicts({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.sessions[1].id);
  const [zoneId, setZoneId] = useState<ZoneId>('family');
  const [lane, setLane] = useState<number | undefined>(undefined);
  const [title, setTitle] = useState('蓝鲸游泳培训·暑期少儿包场');
  const [contact, setContact] = useState('赵晓');
  const [phone, setPhone] = useState('13800000005');
  const [capacity, setCapacity] = useState(30);
  const [commercial, setCommercial] = useState(true);
  const [lastConflicts, setLastConflicts] = useState<string[] | null>(null);

  const session = state.sessions.find((s) => s.id === sessionId)!;
  const myConflicts = state.conflicts.filter((c) => c.sessionId === sessionId);

  const submit = () =>
    act.mutateAsync({
      path: '/locks',
      body: { sessionId, zoneId, lane, reason: commercial ? 'institution_rental' : 'coaching' as LockReason, title, contactName: contact, contactPhone: phone, capacity, isCommercial: commercial },
    }).then((r: any) => {
      setLastConflicts(r.conflicts);
      notify.ok(r.conflicts.length ? '锁区已登记，存在冲突已标红预警' : '锁区已登记，无冲突');
    }).catch((e) => notify.err(e));

  return (
    <div className="grid cols-2">
      <Card title="⚖️ 商业预约 vs 居民公益时段冲突看板">
        {state.conflicts.length === 0 ? <Empty text="当前无商业/公益冲突" /> : state.conflicts.map((c, i) => (
          <div key={i} className="notif critical">
            <div className="flex"><b>{c.sessionLabel}</b><span className="spacer" /><Badge tone="danger">冲突</Badge></div>
            <div className="small" style={{ marginTop: 4 }}>{c.message}</div>
          </div>
        ))}
        <h4>按场次查看锁定</h4>
        <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
        {session.publicWelfare && <div className="alert warn">本场为居民公益时段（老人晨泳），登记商业包场将触发强冲突预警。</div>}
        {myConflicts.length === 0 && <div className="alert ok">本场暂无新的冲突。</div>}
        {session.locks.map((l) => (
          <div key={l.id} className="queue-row">
            <div><b>{l.title}</b>
              <div className="small muted">{state.zones.find((z) => z.id === l.zoneId)?.name}{l.lane ? ` ${l.lane}号道` : '整区'} · {l.capacity} 人 · {l.contactName}</div></div>
            <div className="flex">
              <Badge tone={l.isCommercial ? 'danger' : 'purple'}>{l.isCommercial ? '商业' : '教学'}</Badge>
              <button className="btn sm ghost danger" disabled={act.isPending}
                onClick={() => { if (confirm('解除该锁区？关联的待入场预约将被取消。')) act.mutateAsync({ path: `/locks/${l.id}`, method: 'DELETE' }).then(() => notify.ok('锁区已解除，名额释放给居民')).catch((e) => notify.err(e)); }}>
                解除
              </button>
            </div>
          </div>
        ))}
      </Card>

      <Card title="登记商业包场 / 教学锁区">
        <div className="form-row">
          <label className="field">场次<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{state.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}{s.publicWelfare ? '（公益）' : ''}</option>)}</select></label>
          <label className="field">泳区<select value={zoneId} onChange={(e) => setZoneId(e.target.value as ZoneId)}>{state.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></label>
        </div>
        <div style={{ height: 10 }} />
        <div className="form-row">
          <label className="field">泳道（可空=整区）
            <select value={lane ?? ''} onChange={(e) => setLane(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">整区锁定</option>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} 号道</option>)}
            </select>
          </label>
          <label className="field">占用名额<input type="number" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>
        </div>
        <div style={{ height: 10 }} />
        <label className="field">事项标题<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div style={{ height: 10 }} />
        <div className="form-row">
          <label className="field">联系人<input value={contact} onChange={(e) => setContact(e.target.value)} /></label>
          <label className="field">电话<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>
        <div style={{ height: 10 }} />
        <label className="checkbox"><input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} /> 商业性质（培训机构包场；不勾选则为内部教学道）</label>
        <div style={{ height: 12 }} />
        <button className="btn" disabled={act.isPending} onClick={submit}>登记并做冲突检测</button>
        {lastConflicts && (
          <div className={`alert ${lastConflicts.length ? 'danger' : 'ok'}`} style={{ marginTop: 12 }}>
            {lastConflicts.length ? <>检测到 {lastConflicts.length} 项冲突：{lastConflicts.map((m, i) => <div key={i}>· {m}</div>)}</> : '与居民公益时段及现有预约无冲突。'}
          </div>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>系统同时覆盖：外来访客散客票、老人晨泳公益场、暑期儿童高峰晚场（容量预警）、机构对公包场，冲突在此一屏协调。</div>
      </Card>
    </div>
  );
}

// ============ 闭池 / 恢复 ============
const CAUSES: { v: IncidentType | 'other'; label: string }[] = [
  { v: 'water_abnormal', label: '水质异常' }, { v: 'thunderstorm', label: '雷雨临近' },
  { v: 'equipment_fault', label: '设备故障' }, { v: 'medical', label: '突发医疗事件' }, { v: 'other', label: '其他原因' },
];

function CloseReopen({ state, user }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [sessionId, setSessionId] = useState(state.boards[1]?.session.id ?? state.boards[0].session.id);
  const [reason, setReason] = useState('雷电预警，暂停开放');
  const [cause, setCause] = useState<IncidentType | 'other'>('thunderstorm');
  const [refund, setRefund] = useState(true);
  const [voucher, setVoucher] = useState(true);
  const [push, setPush] = useState(true);
  const [retest, setRetest] = useState(true);

  const session = state.sessions.find((s) => s.id === sessionId)!;
  const affected = state.bookings.filter((b) => b.sessionId === sessionId && (b.status === 'booked' || b.status === 'checked_in'));
  const estWallet = affected.filter((b) => b.paymentMethod === 'wallet').reduce((s, b) => s + b.paidAmount, 0);
  const estVoucher = affected.filter((b) => b.paymentMethod === 'voucher').length;
  const estCash = affected.filter((b) => b.paymentMethod === 'cash').reduce((s, b) => s + b.paidAmount, 0);

  // 恢复门禁以“当前生效闭池档案”为唯一依据（清场清洁 + 消毒复测 + 必要的达标水质）
  const activeRecord = state.closureRecords.find((r) => r.id === session.activeClosureId);
  const closureTask = (kind: 'cleaning' | 'disinfection') => {
    if (!activeRecord) return undefined;
    const t = state.workTasks.find((x) => activeRecord.taskIds.includes(x.id) && x.kind === kind);
    return t;
  };
  const cleaningTask = closureTask('cleaning');
  const disinfectionTask = closureTask('disinfection');
  const cleaningDone = cleaningTask?.status === 'done';
  const disinfectionDone = disinfectionTask?.status === 'done';
  const afterCloseReadings = activeRecord
    ? state.waterReadings.filter((w) => w.sessionId === sessionId && w.at > activeRecord.closedAt)
    : [];
  const retestPass = afterCloseReadings.some((w) => !w.abnormal);
  const waterRequired = activeRecord?.requireWaterRetest;
  const canReopen = !!activeRecord && cleaningDone && disinfectionDone && (!waterRequired || retestPass);
  const reopenBlockers = [
    !cleaningDone ? '清场清洁工单未完成' : '',
    !disinfectionDone ? '消毒复测工单未完成' : '',
    waterRequired && !retestPass ? '尚无达标水质复测' : '',
  ].filter(Boolean);

  const close = () =>
    act.mutateAsync({ path: '/pool-status', body: { sessionId, status: 'closed', reason, cause, refund, compVoucher: voucher, notifyResidents: push, requireWaterRetest: retest } })
      .then((r: any) => notify.ok(`闭池联动完成：储值退 ${r.walletRefundCount ?? 0} 笔、原券返还 ${r.originalVoucherReturnCount ?? 0} 张、现场登记 ${r.cashRefundCount ?? 0} 笔、额外补偿券 ${r.extraVoucherCount ?? 0} 张`)).catch((e) => notify.err(e));
  const reopen = () =>
    act.mutateAsync({ path: '/pool-status', body: { sessionId, status: 'normal' } })
      .then(() => notify.ok('已恢复开放，居民端/现场端状态同步刷新')).catch((e) => notify.err(e));

  return (
    <div>
      <SessionPicker sessions={state.sessions} value={sessionId} onChange={setSessionId} />
      <PoolStatusBanner status={session.poolStatus} reason={session.statusReason} requireRetest={session.requireWaterRetest} closedAt={session.closedAt} reopenedAt={session.reopenedAt} />
      <div className="grid cols-2">
        <Card title="闭池决策与一键联动">
          {session.poolStatus === 'closed' && activeRecord ? (
            <div>
              <div className="alert danger">第{zh(activeRecord.seq)}轮闭池中：{activeRecord.reason}</div>
              <h4>恢复开放前置条件核对（以本轮闭池档案为唯一依据）</h4>
              <div className="task-row done"><div className="content">退费/补偿：{bookingsDone(state, sessionId)}</div><Badge tone="ok">已联动</Badge></div>
              <div className={`task-row ${cleaningDone ? 'done' : ''}`}>
                <div className="content">清场清洁工单{cleaningTask ? `（${cleaningTask.assigneeName ?? '保洁'} ${cleaningTask.status === 'done' ? '已完成：' + (cleaningTask.result ?? '') : cleaningTask.status === 'in_progress' ? '处理中' : '待处理'}）` : '缺失'}</div>
                {cleaningDone ? <Badge tone="ok">已完成</Badge> : <Badge tone="danger">未完成</Badge>}
              </div>
              <div className={`task-row ${disinfectionDone ? 'done' : ''}`}>
                <div className="content">消毒复测工单{disinfectionTask ? `（${disinfectionTask.assigneeName ?? '维修'} ${disinfectionTask.status === 'done' ? '已完成：' + (disinfectionTask.result ?? '') : disinfectionTask.status === 'in_progress' ? '处理中' : '待处理'}）` : '缺失'}</div>
                {disinfectionDone ? <Badge tone="ok">已完成</Badge> : <Badge tone="danger">未完成</Badge>}
              </div>
              {waterRequired && (
                <div className={`task-row ${retestPass ? 'done' : ''}`}>
                  <div className="content">达标水质复测（晚于本轮闭池时间）{afterCloseReadings.length ? `，已提交 ${afterCloseReadings.length} 次${retestPass ? '，最近一次达标' : ''}` : '，维修尚未提交复测'}</div>
                  {retestPass ? <Badge tone="ok">已达标</Badge> : <Badge tone="danger">未达标</Badge>}
                </div>
              )}
              {!canReopen && (
                <div className="alert warn">还不能恢复开放：{reopenBlockers.join('、')}。请在保洁/维修完成各自工单{waterRequired ? '，并由维修/救生员录入一次达标水质复测' : ''}后再恢复。</div>
              )}
              <button className="btn" style={{ marginTop: 10 }} disabled={act.isPending || !canReopen} onClick={reopen}>
                {canReopen ? '✅ 处置全部完成，恢复开放（同步居民端与现场端）' : '处置未完成，禁止恢复开放'}
              </button>
            </div>
          ) : (
            <div>
              <div className="form-row">
                <label className="field">闭池原因分类<select value={cause} onChange={(e) => setCause(e.target.value as any)}>{CAUSES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}</select></label>
                <label className="field">状态
                  <select value={session.poolStatus} onChange={(e) => {
                    if (e.target.value === 'restricted') act.mutateAsync({ path: '/pool-status', body: { sessionId, status: 'restricted', reason: reason || '现场异常限流' } }).then(() => notify.ok('已切换为限流')).catch((x) => notify.err(x));
                  }}>
                    <option value="normal">正常开放</option><option value="restricted">先限流观察</option><option value="closed">闭池</option>
                  </select>
                </label>
              </div>
              <div style={{ height: 10 }} />
              <label className="field">向居民与各角色的说明<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <div style={{ height: 10 }} />
              <label className="checkbox"><input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} /> 预约费原路退回储值（现金单登记线下退）</label>
              <label className="checkbox"><input type="checkbox" checked={voucher} onChange={(e) => setVoucher(e.target.checked)} /> 每人发放 1 张补偿券（可抵一次入场）</label>
              <label className="checkbox"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> 向受影响居民逐人推送通知 + 全员公告</label>
              <label className="checkbox"><input type="checkbox" checked={retest} onChange={(e) => setRetest(e.target.checked)} /> 要求水质复测达标后方可恢复开放</label>
              <div className="alert warn" style={{ marginTop: 10 }}>
                本次将影响 <b>{affected.length}</b> 笔预约，按原渠道分别处理：储值退 <b>¥{estWallet}</b>、原券返还 <b>{estVoucher}</b> 张、现场退款登记 <b>¥{estCash}</b>{voucher ? '，另每人发放额外补偿券 1 张' : ''}；同时自动：救生员撤哨清场、生成维修消毒复测工单与保洁清场工单、关联事件追加联动记录。
              </div>
              <button className="btn danger" disabled={!reason.trim() || act.isPending} onClick={() => { if (confirm('确认闭池并执行联动？居民将立即收到通知。')) close(); }}>🚫 确认闭池并执行联动</button>
            </div>
          )}
        </Card>

        <Card title="联动结果核对（防止两端状态不一致）">
          <h4>受影响预约</h4>
          {affected.length === 0 && <Empty text="无受影响预约" />}
          <div className="table-wrap"><table>
            <thead><tr><th>码</th><th>泳客</th><th>金额</th><th>支付</th><th>状态</th></tr></thead>
            <tbody>{state.bookings.filter((b) => b.sessionId === sessionId).map((b) => (
              <tr key={b.id}><td className="code-mono">{b.code}</td><td className="small">{userName(state, b.userId)?.name}</td><td>{b.paidAmount}</td>
                <td className="small">{b.paymentMethod === 'wallet' ? '储值' : b.paymentMethod === 'voucher' ? '券' : '现金'}</td>
                <td><Badge tone={BOOKING_STATUS_BADGE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge></td></tr>
            ))}</tbody></table></div>
          <h4>最近的居民通知</h4>
          {state.notifications.filter((n) => n.sessionId === sessionId).slice(0, 6).map((n) => (
            <div key={n.id} className={`notif ${n.level}`}><b className="small">{n.title}</b><div className="small muted">{n.body}</div></div>
          ))}
        </Card>
      </div>

      <ClosureArchives state={state} sessionId={sessionId} />
    </div>
  );
}

/** 历次闭池处置档案：不可变快照，多轮闭池独立呈现 */
function ClosureArchives({ state, sessionId }: { state: AppState; sessionId: string }) {
  const records = state.closureRecords
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => b.seq - a.seq);
  if (records.length === 0) return null;
  return (
    <Card className="section-gap" title={`闭池处置档案（本场共 ${records.length} 轮，归档后不可被当前状态覆盖）`}>
      <div className="grid cols-2">
        {records.map((r) => (
          <div key={r.id} className={`notif ${r.status === 'closed' ? 'critical' : 'info'}`}>
            <div className="flex">
              <b>第{zh(r.seq)}轮闭池 · {r.cause === 'other' ? '其他原因' : INCIDENT_TYPE_LABEL[r.cause]}</b>
              <span className="spacer" />
              <Badge tone={r.status === 'closed' ? 'danger' : 'ok'}>{r.status === 'closed' ? '闭池中' : '已恢复'}</Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>原因：{r.reason}</div>
            <dl className="kv small" style={{ marginTop: 6 }}>
              <dt>闭池时间</dt><dd>{fmtDateTime(r.closedAt)} · {r.closedBy}</dd>
              <dt>原渠道退款</dt>
              <dd>储值 {r.walletRefundCount} 笔/¥{r.walletRefundTotal} · 原券返还 {r.originalVoucherReturnCount} 张 · 现场登记 {r.cashRefundCount} 笔/¥{r.cashRefundTotal}
                {r.extraVoucherCount > 0 && <span className="badge purple" style={{ marginLeft: 6 }}>额外补偿券 {r.extraVoucherCount} 张</span>}
              </dd>
              <dt>清场</dt><dd>撤哨 {r.guardReliefCount} 人 · 联动工单 {r.taskIds.length} 个</dd>
              <dt>通知</dt><dd>{r.announcementIds.length} 条（全员公告+逐人通知）</dd>
              <dt>恢复门禁</dt>
              <dd>{r.status === 'reopened'
                ? `清场${r.reopenChecklist?.cleaning ? '✓(' + (r.reopenChecklist.cleaning.assigneeName ?? '保洁') + ')' : '—'} · 消毒${r.reopenChecklist?.disinfection ? '✓(' + (r.reopenChecklist.disinfection.assigneeName ?? '维修') + ')' : '—'}${r.requireWaterRetest ? ' · 水质复测✓' : ''}`
                : '等待清场、消毒与必要复测全部完成'}</dd>
              <dt>恢复</dt><dd>{r.status === 'reopened' ? `${fmtDateTime(r.reopenedAt)} · ${r.reopenedBy ?? ''}${r.retestReadingId ? ' · 复测 ' + r.retestReadingId + ' 达标' : ''}` : '处置未完成，禁止恢复'}</dd>
            </dl>
            <details style={{ marginTop: 6 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>逐人处置结果（{r.affected.length}）</summary>
              <div className="table-wrap" style={{ marginTop: 6 }}><table>
                <thead><tr><th>预约码</th><th>泳客</th><th>原渠道</th><th>原渠道退款结果</th><th>额外补偿券</th><th>通知</th></tr></thead>
                <tbody>{r.affected.map((a) => (
                  <tr key={a.bookingId}>
                    <td className="code-mono small">{a.bookingCode}</td><td className="small">{a.userName}</td>
                    <td>{a.paymentMethod === 'wallet' ? '储值' : a.paymentMethod === 'voucher' ? '补偿券' : '现场支付'}</td>
                    <td className="small">{refundResultText(a)}</td>
                    <td>{a.extraCompVoucher ? '1 张' : '—'}</td>
                    <td>{a.notificationId ? '已送达' : '—'}</td>
                  </tr>
                ))}</tbody></table></div>
            </details>
            <div className="small muted" style={{ marginTop: 4 }}>档案号 {r.id}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function bookingsDone(state: AppState, sessionId: string) {
  const list = state.bookings.filter((b) => b.sessionId === sessionId && (b.status === 'refunded' || b.status === 'compensated'));
  return list.length ? `已处理 ${list.length} 笔（退费/补偿到账）` : '进行中';
}

// ============ 事件指挥 ============
function IncidentTab({ user, state }: Props) {
  return (
    <div className="grid cols-2">
      <IncidentCreateForm sessions={state.sessions} />
      <Card title="事件指挥（前台/救生/保洁/维修同屏协同）">
        <IncidentList incidents={state.incidents} user={user} />
      </Card>
    </div>
  );
}

// ============ 工单派发 ============
function Dispatch({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [kind, setKind] = useState<TaskKind>('cleaning');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [role, setRole] = useState<'cleaner' | 'maintenance'>('cleaner');
  const [sessionId, setSessionId] = useState(state.sessions[1]?.id ?? state.sessions[0].id);

  return (
    <div className="grid cols-2">
      <Card title="派发工单（保洁/维修/消毒）">
        <div className="form-row">
          <label className="field">类型<select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            <option value="cleaning">保洁</option><option value="maintenance">维修</option><option value="disinfection">泳池消毒</option>
          </select></label>
          <label className="field">负责岗位<select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="cleaner">保洁</option><option value="maintenance">维修</option>
          </select></label>
        </div>
        <div style={{ height: 10 }} />
        <label className="field">关联场次<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{state.sessions.map((s) => <option key={s.id}>{s.label}</option>)}</select></label>
        <div style={{ height: 10 }} />
        <label className="field">标题<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：晚高峰前淋浴区深度清洁" /></label>
        <div style={{ height: 10 }} />
        <label className="field">详细要求<textarea value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        <div style={{ height: 10 }} />
        <button className="btn" disabled={!title.trim() || act.isPending}
          onClick={() => act.mutateAsync({ path: '/tasks', body: { kind, title, detail, assigneeRole: role, sessionId } }).then(() => { notify.ok('工单已派发'); setTitle(''); setDetail(''); }).catch((e) => notify.err(e))}>派发</button>
      </Card>
      <Card title="全部工单">
        {state.workTasks.length === 0 ? <Empty text="暂无工单" /> : state.workTasks.map((t) => (
          <div key={t.id} className="queue-row">
            <div><b className="small">{t.title}</b>
              <div className="small muted">{t.detail} · {t.assigneeRole === 'cleaner' ? '保洁' : '维修'}{t.assigneeName ? ` · ${t.assigneeName}` : ''} · {fmtDateTime(t.createdAt)}</div></div>
            <div className="flex">
              <Badge tone={t.kind === 'disinfection' ? 'purple' : 'gray'}>{t.kind === 'disinfection' ? '消毒' : t.kind === 'maintenance' ? '维修' : '保洁'}</Badge>
              <Badge tone={t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'danger'}>{TASK_STATUS_LABEL[t.status]}</Badge>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ============ 投诉 ============
function Complaints({ state }: Props) {
  const act = useAction();
  const notify = useNotify();
  const [reply, setReply] = useState<Record<string, string>>({});
  const open = state.complaints.filter((c) => c.status === 'open');
  const done = state.complaints.filter((c) => c.status === 'replied');
  return (
    <div className="grid cols-2">
      <Card title={`待处理投诉（${open.length}）`}>
        {open.length === 0 ? <Empty text="暂无待处理投诉" /> : open.map((c) => (
          <div key={c.id} className="notif warning">
            <div className="flex"><b>[{c.category}]</b><span className="spacer" /><span className="small muted">{userName(state, c.userId)?.name} · {fmtDateTime(c.at)}</span></div>
            <div className="small" style={{ margin: '4px 0' }}>{c.content}</div>
            <textarea placeholder="回复处理结果（居民端立即可见）" value={reply[c.id] ?? ''} onChange={(e) => setReply((r) => ({ ...r, [c.id]: e.target.value }))} />
            <button className="btn sm" style={{ marginTop: 8 }} disabled={act.isPending || !(reply[c.id] ?? '').trim()}
              onClick={() => act.mutateAsync({ path: `/complaints/${c.id}/reply`, body: { reply: reply[c.id] } }).then(() => notify.ok('已回复居民')).catch((e) => notify.err(e))}>回复</button>
          </div>
        ))}
      </Card>
      <Card title="已回复">
        {done.length === 0 ? <Empty text="暂无" /> : done.map((c) => (
          <div key={c.id} className="notif info">
            <div className="flex"><b>[{c.category}] {userName(state, c.userId)?.name}</b><span className="spacer" /><Badge tone="ok">已回复</Badge></div>
            <div className="small">{c.content}</div>
            <div className="small" style={{ marginTop: 4, padding: 7, background: 'var(--ok-bg)', borderRadius: 7 }}>{c.reply}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

export function OpsPage(props: Props) {
  if (props.tab === 'conflict') return <Conflicts {...props} />;
  if (props.tab === 'close') return <CloseReopen {...props} />;
  if (props.tab === 'incident') return <IncidentTab {...props} />;
  if (props.tab === 'tasks') return <Dispatch {...props} />;
  if (props.tab === 'complaint') return <Complaints {...props} />;
  return <Command {...props} />;
}

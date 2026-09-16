import type {
  CrampRescue, DB, GuardDuty, GuardFocusLane, Incident, RescueClosureKey, SuspendedLane, User, ZoneId,
} from '../shared/types.js';
import {
  CRAMP_PART_LABEL, RESCUE_CLOSURE_LABEL, RESCUE_METHOD_LABEL,
} from '../shared/types.js';
import { nextId } from './store.js';
import { HttpError, openIncident, pushNotification } from './domain.js';

const now = () => new Date().toISOString();

/** 救援收尾三项确认的固定顺序 */
export const RESCUE_CLOSURE_KEYS: RescueClosureKey[] = ['guard_relief', 'lane_reopen', 'order_restored'];

function zoneName(db: DB, zoneId: ZoneId) {
  return db.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
}

export function getRescue(db: DB, id: string) {
  const r = db.crampRescues.find((x) => x.id === id);
  if (!r) throw new HttpError(404, '抽筋救援记录不存在');
  return r;
}

/** 关联协同事件：同场次若已有进行中的抽筋事件则挂到同一事件，不重复立案 */
function attachCrampIncident(db: DB, sessionId: string, content: string, by: string): Incident | undefined {
  const open = db.incidents.find((i) => i.sessionId === sessionId && i.type === 'cramp' && i.status !== 'resolved');
  if (open) {
    open.actions.push({ id: nextId('ia'), at: now(), by, byRole: 'lifeguard', content });
    return open;
  }
  try {
    const inc = openIncident(db, sessionId, 'cramp', undefined, content, by);
    return inc;
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      const existing = db.incidents.find((i) => i.sessionId === sessionId && i.type === 'cramp' && i.status !== 'resolved');
      existing?.actions.push({ id: nextId('ia'), at: now(), by, byRole: 'lifeguard', content });
      return existing;
    }
    throw e;
  }
}

// ============ 1. 救生员记录抽筋救援 ============
export function createCrampRescue(db: DB, guard: User, req: {
  sessionId: string; zoneId: ZoneId; lane: number; foundAt?: string;
  crampPart: keyof typeof CRAMP_PART_LABEL; patronDesc: string;
  method: keyof typeof RESCUE_METHOD_LABEL; shoreTreatment: string;
  familyContacted: boolean; familyNote?: string; medicalAdvised: boolean; medicalNote?: string;
}) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  if (session.poolStatus === 'closed') throw new HttpError(409, '该场次已闭池，不能登记救援记录');
  if (!db.zones.some((z) => z.id === req.zoneId)) throw new HttpError(404, '泳区不存在');
  const lane = Math.trunc(Number(req.lane));
  if (!(lane >= 1 && lane <= 12)) throw new HttpError(400, '泳道号需在 1-12 之间');
  if (!CRAMP_PART_LABEL[req.crampPart]) throw new HttpError(400, '抽筋部位不合法');
  if (!RESCUE_METHOD_LABEL[req.method]) throw new HttpError(400, '救援方式不合法');
  if (!req.shoreTreatment.trim()) throw new HttpError(400, '请填写上岸处理（拉伸/保暖/观察/AED 等）');
  if (!req.patronDesc.trim()) throw new HttpError(400, '请简要描述被救泳客（柜号/会员特征，便于家属联系与复盘）');

  // 同一泳道同一时间只允许一条未收尾的救援记录，避免重复临停
  const dup = db.crampRescues.find(
    (r) => r.sessionId === session.id && r.zoneId === req.zoneId && r.lane === lane && r.laneSuspended,
  );
  if (dup) throw new HttpError(409, `${zoneName(db, req.zoneId)} ${lane} 号道已有进行中的救援 ${dup.code}，请先完成该泳道救援收尾`);

  const id = nextId('cr');
  const code = `CR-${db.counters.seq}`;
  const foundAt = req.foundAt ? new Date(req.foundAt).toISOString() : now();

  const rescue: CrampRescue = {
    id, code, sessionId: session.id, zoneId: req.zoneId, lane,
    foundAt, guardName: guard.name, crampPart: req.crampPart,
    patronDesc: String(req.patronDesc).slice(0, 120),
    method: req.method, shoreTreatment: String(req.shoreTreatment).slice(0, 300),
    familyContacted: !!req.familyContacted, familyNote: req.familyNote?.slice(0, 200),
    medicalAdvised: !!req.medicalAdvised, medicalNote: req.medicalNote?.slice(0, 200),
    closure: {
      guard_relief: { done: false },
      lane_reopen: { done: false },
      order_restored: { done: false },
    } as Record<RescueClosureKey, { done: boolean; at?: string; by?: string; note?: string }>,
    adjustments: [],
    laneSuspended: true,
    laneSuspendReason: '抽筋救援处置，泳道临时关闭',
    trainingIds: [],
    intoSchedule: false,
    createdAt: now(),
  };
  db.crampRescues.unshift(rescue);

  // 泳道临停（写入场次；居民预约/核验链路可据此拦截该泳道）
  const suspended: SuspendedLane = {
    zoneId: req.zoneId, lane, reason: rescue.laneSuspendReason!, since: now(), rescueId: id,
  };
  session.suspendedLanes = [...(session.suspendedLanes ?? []), suspended];
  session.crampRescueCount = (session.crampRescueCount ?? 0) + 1;

  // 自动立案/挂接「泳客抽筋」跨角色协同事件（前台取 AED/联系陪同人、保洁疏散围观、运营跟进送医）
  const inc = attachCrampIncident(
    db, session.id,
    `抽筋救援记录 ${code}：${zoneName(db, req.zoneId)} ${lane} 号道，${CRAMP_PART_LABEL[req.crampPart]}抽筋；`
      + `${RESCUE_METHOD_LABEL[req.method]}；上岸处理：${req.shoreTreatment}；`
      + `${req.familyContacted ? '已联系家属' : '未联系家属'}；${req.medicalAdvised ? '已建议就医' : '未建议就医'}。`
      + `该泳道已临停，救援结束后须完成换岗、泳道恢复、秩序恢复三项确认。`,
    guard.name,
  );
  if (inc) rescue.incidentId = inc.id;

  pushNotification(db, {
    title: `🆘 抽筋救援 ${code}：${session.label} ${zoneName(db, req.zoneId)} ${lane} 号道临停`,
    body: `发现时间 ${new Date(foundAt).toTimeString().slice(0, 5)}，${CRAMP_PART_LABEL[req.crampPart]}抽筋，${RESCUE_METHOD_LABEL[req.method]}。`
      + `救生员 ${guard.name} 正在处置；请前台待命联系家属/取 AED，保洁疏散围观泳客，运营跟进。${req.medicalAdvised ? '已建议泳客就医。' : ''}`,
    level: req.medicalAdvised ? 'critical' : 'warning',
    roles: ['lifeguard', 'frontdesk', 'cleaner', 'ops'], sessionId: session.id,
  });

  return rescue;
}

// ============ 2. 救援收尾三项确认 ============
export function confirmRescueClosure(db: DB, user: User, rescueId: string, key: string, req: { note?: string; relief?: string }) {
  if (!(RESCUE_CLOSURE_KEYS as string[]).includes(key)) throw new HttpError(400, '未知的收尾确认项');
  const closureKey = key as RescueClosureKey;
  const rescue = getRescue(db, rescueId);
  const session = db.sessions.find((s) => s.id === rescue.sessionId)!;
  const state = rescue.closure[closureKey];
  if (state.done) throw new HttpError(409, `「${RESCUE_CLOSURE_LABEL[closureKey]}」已确认（${state.by} · ${new Date(state.at!).toTimeString().slice(0, 5)}），不可重复确认`);

  let detail = '';

  if (key === 'guard_relief') {
    // 真实联动换岗：结束施救救生员当前在岗记录，接班人自动上同一站位
    const rescueGuard = db.users.find((u) => u.name === rescue.guardName && u.role === 'lifeguard');
    const activeDuty = rescueGuard
      ? db.guardDuties.find((d) => d.sessionId === session.id && d.guardUserId === rescueGuard.id && !d.end)
      : undefined;
    const reliefName = String(req.relief || '').trim();
    if (!reliefName && !(req.note || '').trim())
      throw new HttpError(400, '请填写接班救生员（名册内姓名），或填写线下换岗说明');

    if (reliefName) {
      const reliefUser = db.users.find((u) => u.name === reliefName && u.role === 'lifeguard');
      if (!reliefUser) throw new HttpError(400, `接班人「${reliefName}」不在救生员名册`);
      const busy = db.guardDuties.find((d) => d.sessionId === session.id && d.guardUserId === reliefUser.id && !d.end);
      if (busy) throw new HttpError(409, `${reliefName} 当前已在其他站位在岗，请先安排其下哨`);
      if (activeDuty) {
        activeDuty.end = now();
        activeDuty.relief = reliefName;
        activeDuty.note = `抽筋救援 ${rescue.code} 后换岗：${req.note || '施救后休整'}`;
        activeDuty.crampRescueId = rescue.id;
        const nd: GuardDuty = {
          id: nextId('gd'), sessionId: session.id, guardUserId: reliefUser.id,
          post: activeDuty.post, start: now(), relief: undefined,
          note: `接替抽筋救援 ${rescue.code} 站位`, crampRescueId: rescue.id,
        };
        db.guardDuties.unshift(nd);
        detail = `${rescue.guardName} 下哨休整，${reliefName} 已接替同一站位`;
      } else {
        detail = `换岗已确认：${reliefName} 到岗（原救生员无在岗站位记录，按线下换岗登记）`;
      }
    } else {
      detail = `换岗已线下确认：${req.note}`;
    }
  }

  if (key === 'lane_reopen') {
    if (!rescue.laneSuspended) throw new HttpError(409, '该泳道已恢复，无需重复确认');
    rescue.laneSuspended = false;
    session.suspendedLanes = (session.suspendedLanes ?? []).filter((l) => l.rescueId !== rescue.id);
    detail = `${zoneName(db, rescue.zoneId)} ${rescue.lane} 号道临停解除，重新开放入池`;
    pushNotification(db, {
      title: `🟢 泳道恢复：${session.label} ${zoneName(db, rescue.zoneId)} ${rescue.lane} 号道`,
      body: `抽筋救援 ${rescue.code} 现场处置完毕，救生员确认泳道已重新开放。`,
      level: 'info', roles: ['lifeguard', 'frontdesk', 'ops'], sessionId: session.id,
    });
  }

  if (key === 'order_restored') {
    detail = '水面秩序恢复：围观泳客已疏散，各泳道游进秩序正常';
  }

  state.done = true;
  state.at = now();
  state.by = user.name;
  state.note = req.note || detail;

  if (rescue.incidentId) {
    const inc = db.incidents.find((i) => i.id === rescue.incidentId);
    inc?.actions.push({
      id: nextId('ia'), at: now(), by: user.name, byRole: user.role,
      content: `救援收尾确认：${RESCUE_CLOSURE_LABEL[closureKey]}（${req.note || detail}）`,
    });
  }

  const allDone = RESCUE_CLOSURE_KEYS.every((k) => rescue.closure[k].done);
  if (allDone) {
    pushNotification(db, {
      title: `✅ 抽筋救援 ${rescue.code} 收尾三项确认全部完成`,
      body: '救生员换岗、泳道临停解除、水面秩序恢复均已确认；记录进入本场复盘，站位调整结果将提醒下一场重点关注该泳道。',
      level: 'info', roles: ['lifeguard', 'ops', 'frontdesk'], sessionId: session.id,
    });
    if (rescue.incidentId) {
      const inc = db.incidents.find((i) => i.id === rescue.incidentId);
      inc?.actions.push({
        id: nextId('ia'), at: now(), by: user.name, byRole: user.role,
        content: `救援 ${rescue.code} 收尾三项确认全部完成，等待运营组织本场复盘。`,
      });
    }
  }

  return rescue;
}

// ============ 3. 救生员站位调整（带动下一场关注泳道） ============
export function adjustRescuePost(db: DB, user: User, rescueId: string, req: { content: string; propagateToNextSessions?: boolean }) {
  const content = String(req.content || '').trim();
  if (!content) throw new HttpError(400, '请填写站位调整内容');
  const rescue = getRescue(db, rescueId);
  const session = db.sessions.find((s) => s.id === rescue.sessionId)!;

  rescue.adjustments.push({ at: now(), by: user.name, content: content.slice(0, 300) });

  const propagate = req.propagateToNextSessions !== false;
  let propagated: { id: string; label: string }[] = [];
  if (propagate) {
    const later = db.sessions
      .filter((s) => s.id !== session.id && (s.date > session.date || (s.date === session.date && s.start > session.start)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    for (const target of later) {
      const exists = (target.guardFocusLanes ?? []).some((f) => f.rescueId === rescue.id && f.lane === rescue.lane && f.zoneId === rescue.zoneId);
      if (exists) continue;
      const focus: GuardFocusLane = {
        zoneId: rescue.zoneId, lane: rescue.lane,
        reason: `上场（${session.label}）该泳道发生抽筋救援 ${rescue.code}：${content}`,
        rescueId: rescue.id, fromSessionId: session.id, at: now(),
      };
      target.guardFocusLanes = [...(target.guardFocusLanes ?? []), focus];
      propagated.push({ id: target.id, label: target.label });
    }
    pushNotification(db, {
      title: `🛟 站位调整已同步：${rescue.code} 关注 ${zoneName(db, rescue.zoneId)} ${rescue.lane} 号道`,
      body: `调整：${content}。已提醒后续 ${propagated.length} 个场次救生巡查重点关注同一泳道（${propagated.map((p) => p.label).join('、') || '无后续场次'}）。`,
      level: 'warning', roles: ['lifeguard', 'ops'], sessionId: session.id,
    });
  }

  if (rescue.incidentId) {
    const inc = db.incidents.find((i) => i.id === rescue.incidentId);
    inc?.actions.push({
      id: nextId('ia'), at: now(), by: user.name, byRole: user.role,
      content: `站位调整：${content}${propagate ? `（已带入后续 ${propagated.length} 个场次重点关注）` : ''}`,
    });
  }

  return { rescue, propagated };
}

/** 下一场救生巡查：救生员确认已关注该泳道 */
export function acknowledgeFocusLane(db: DB, user: User, sessionId: string, focusKey: { rescueId: string; zoneId: ZoneId; lane: number }) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const focus = (session.guardFocusLanes ?? []).find(
    (f) => f.rescueId === focusKey.rescueId && f.zoneId === focusKey.zoneId && f.lane === focusKey.lane,
  );
  if (!focus) throw new HttpError(404, '重点关注泳道提醒不存在');
  focus.ackAt = now();
  focus.ackBy = user.name;
  return focus;
}

// ============ 4. 运营组织本场复盘 → 培训 + 排班 ============
export function reviewCrampRescue(db: DB, ops: User, rescueId: string, req: {
  summary: string; trainingContent: string; targetGuardNames?: string[]; intoSchedule: boolean; scheduleNote?: string;
}) {
  const rescue = getRescue(db, rescueId);
  const session = db.sessions.find((s) => s.id === rescue.sessionId)!;
  const pending = RESCUE_CLOSURE_KEYS.filter((k) => !rescue.closure[k].done);
  if (pending.length) {
    throw new HttpError(409, `救援收尾尚未全部确认（缺：${pending.map((k) => RESCUE_CLOSURE_LABEL[k]).join('、')}），不能复盘`);
  }
  if (rescue.reviewedAt) throw new HttpError(409, `该救援已于 ${rescue.reviewedAt} 完成复盘，复盘结果不可修改`);
  const summary = String(req.summary || '').trim();
  const trainingContent = String(req.trainingContent || '').trim();
  if (!summary) throw new HttpError(400, '请填写本场复盘结论');
  if (!trainingContent) throw new HttpError(400, '请填写纳入救生员培训的要点');

  // 培训对象：默认施救救生员 + 全场在岗救生员；可由运营改选
  let targets = (req.targetGuardNames ?? []).map((x) => x.trim()).filter(Boolean);
  if (targets.length === 0) {
    const onDutyNames = new Set(
      db.guardDuties.filter((d) => d.sessionId === session.id).map((d) => db.users.find((u) => u.id === d.guardUserId)?.name).filter(Boolean) as string[],
    );
    onDutyNames.add(rescue.guardName);
    targets = [...onDutyNames];
  }

  const item = {
    id: nextId('gt'), source: 'cramp_rescue' as const, sourceRescueId: rescue.id,
    sessionId: session.id, sessionLabel: session.label, at: now(),
    title: `抽筋救援复盘培训：${zoneName(db, rescue.zoneId)} ${rescue.lane} 号道（${rescue.code}）`,
    content: trainingContent.slice(0, 500), targetGuardNames: targets,
    intoSchedule: !!req.intoSchedule,
    scheduleNote: req.intoSchedule ? (String(req.scheduleNote || '').slice(0, 200) || '近期排班加强该泳道所在岗位瞭望/带教') : undefined,
    recordedBy: ops.name, done: false,
  };
  db.guardTraining.unshift(item);

  rescue.reviewedAt = now();
  rescue.reviewedBy = ops.name;
  rescue.reviewSummary = summary.slice(0, 500);
  rescue.intoSchedule = !!req.intoSchedule;
  rescue.trainingIds.push(item.id);

  if (rescue.incidentId) {
    const inc = db.incidents.find((i) => i.id === rescue.incidentId);
    inc?.actions.push({
      id: nextId('ia'), at: now(), by: ops.name, byRole: 'ops',
      content: `本场抽筋救援复盘完成：${summary}；培训项 ${item.id} 已纳入${req.intoSchedule ? '，并进入近期排班' : ''}。`,
    });
  }

  pushNotification(db, {
    title: `📚 救生员培训项（来自 ${session.label} 抽筋救援复盘 ${rescue.code}）`,
    body: `${trainingContent}${req.intoSchedule ? ` 排班安排：${item.scheduleNote}` : ''}`,
    level: 'info', roles: ['lifeguard', 'ops'], sessionId: session.id,
  });

  return { rescue, training: item };
}

/** 培训完成（救生员参训登记 / 运营确认） */
export function completeTraining(db: DB, id: string, result?: string) {
  const item = db.guardTraining.find((t) => t.id === id);
  if (!item) throw new HttpError(404, '培训项不存在');
  if (item.done) throw new HttpError(409, '该培训项已完成');
  item.done = true;
  item.doneAt = now();
  if (result) item.content += `\n【参训结果】${String(result).slice(0, 200)}`;
  return item;
}

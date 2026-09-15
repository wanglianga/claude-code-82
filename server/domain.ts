import type {
  DB, Booking, BookingKind, MemberTier, Incident, IncidentTask, IncidentType,
  Notification, Role, Session, WaterReading, Zone, ZoneId, WorkTask, PatrolIssue,
  LiveBoard, ZoneLiveStat, GuardPost, PoolStatus,
} from '../shared/types.js';
import { GUARD_POST_LABEL } from '../shared/types.js';
import { WATER_STD, evaluateWater, priceOf } from '../shared/logic.js';
import { mutate, nextId } from './store.js';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

// 水质标准/判定、计价见 shared/logic.ts（前后端共用）
export { WATER_STD, evaluateWater, priceOf };

// ============ 查询辅助 ============
export function activeBookings(db: DB, sessionId: string): Booking[] {
  return db.bookings.filter(
    (b) => b.sessionId === sessionId && b.status !== 'cancelled' && b.status !== 'refunded' && b.status !== 'compensated',
  );
}

export function zoneLocked(db: DB, session: Session, zoneId: ZoneId, lane?: number) {
  let seats = 0;
  const hits = session.locks.filter((l) => {
    if (l.zoneId !== zoneId) return false;
    if (lane == null) return true;
    if (l.lane == null) return true; // 整区锁定覆盖所有泳道
    return l.lane === lane;
  });
  hits.forEach((h) => (seats += h.capacity));
  return { seats, hits };
}

export function zoneCounts(db: DB, sessionId: string, zoneId: ZoneId) {
  const list = activeBookings(db, sessionId).filter((b) => b.zoneId === zoneId);
  const booked = list.filter((b) => b.status === 'booked').reduce((s, b) => s + Math.max(1, b.partySize), 0);
  const checked = list.filter((b) => b.status === 'checked_in');
  const inPool = checked.reduce((s, b) => s + Math.max(1, b.partySize), 0);
  const children = checked.reduce((s, b) => s + (b.childrenInParty ?? (b.withChildren ? b.childCount : 0)), 0);
  const deepHolders = checked.filter((b) => {
    const u = db.users.find((x) => x.id === b.userId);
    return u?.deepCert;
  }).length;
  return { booked, inPool, children, deepHolders, list };
}

/** 商业包场/锁区 vs 居民公益时段、既有居民预约、泳道占用的冲突 */
export function lockConflicts(db: DB, session: Session, lock: { id?: string; zoneId: ZoneId; lane?: number; capacity: number; isCommercial: boolean }) {
  const msgs: string[] = [];
  if (session.publicWelfare && lock.isCommercial) {
    msgs.push(`商业包场与「${session.label}」居民公益时段直接冲突，须先保障公益名额`);
  }
  const residentKinds: BookingKind[] = ['personal', 'parent_child', 'elder_morning', 'coaching', 'guest'];
  const residents = activeBookings(db, session.id).filter(
    (b) => residentKinds.includes(b.kind) && b.zoneId === lock.zoneId &&
      (lock.lane == null || b.lane == null || lock.lane === b.lane),
  );
  if (residents.length) {
    const people = residents.reduce((s, b) => s + Math.max(1, b.partySize), 0);
    msgs.push(`该区域已有 ${residents.length} 笔居民预约（共 ${people} 人，含 ${residents.map((b) => b.code).join('、')}），包场将挤压居民名额`);
  }
  // 自检时排除锁自身，避免“与自己重叠/重复占容量”
  const otherLocks = session.locks.filter((l) => l.id !== lock.id);
  const overlapLock = otherLocks.find(
    (l) => l.zoneId === lock.zoneId &&
      (l.lane == null || lock.lane == null || l.lane === lock.lane),
  );
  if (overlapLock) msgs.push(`与现有锁定「${overlapLock.title}」区域/泳道重叠`);

  const zone = db.zones.find((z) => z.id === lock.zoneId)!;
  const lockedByOthers = otherLocks
    .filter((l) => l.zoneId === lock.zoneId)
    .reduce((s, l) => s + l.capacity, 0);
  const { inPool, booked } = zoneCounts(db, session.id, lock.zoneId);
  if (inPool + booked + lockedByOthers + lock.capacity > zone.capacity) {
    msgs.push(`超出泳区容量：在池 ${inPool} + 待入场 ${booked} + 已锁 ${lockedByOthers} + 本次 ${lock.capacity} > 容量 ${zone.capacity}`);
  }
  return msgs;
}

export function pushNotification(db: DB, n: Omit<Notification, 'id' | 'at'>) {
  db.notifications.unshift({ ...n, id: nextId('nt'), at: now() });
  if (db.notifications.length > 200) db.notifications.length = 200;
}

// ============ 跨角色事件模板 ============
function t(role: Role, content: string): IncidentTask {
  return { id: nextId('it'), role, content, done: false };
}

export function buildIncidentTasks(type: IncidentType): { title: string; severity: Incident['severity']; tasks: IncidentTask[] } {
  switch (type) {
    case 'water_abnormal':
      return { title: '水质异常', severity: 'critical', tasks: [
        t('lifeguard', '立即停止向异常泳区放行，在池泳客岸上观察，准备清场'),
        t('frontdesk', '暂停该场次入场核验，向到场居民说明并登记'),
        t('maintenance', '加氯/反冲洗循环系统，排查加药设备，30 分钟内复测'),
        t('cleaner', '配合清场，清理池岸、铺设防滑垫'),
        t('ops', '评估限流/闭池，组织水质复测并统一对外通知'),
      ] };
    case 'thunderstorm':
      return { title: '雷雨临近', severity: 'critical', tasks: [
        t('lifeguard', '鸣哨清场，所有泳客立即上岸进入室内避险'),
        t('frontdesk', '广播通知，登记提前离场泳客以备退费补偿'),
        t('cleaner', '检查门窗、铺防滑垫、引导室内避雨'),
        t('maintenance', '切断户外用电设备、检查防雷与排水'),
        t('ops', '决定闭池并联动退费、补偿券与居民通知'),
      ] };
    case 'cramp':
      return { title: '泳客抽筋', severity: 'major', tasks: [
        t('lifeguard', '下水施救，转移上岸并做拉伸/急救处置'),
        t('frontdesk', '拨打 120 待命，联系陪同人并取 AED'),
        t('cleaner', '开辟救生通道、疏散围观泳客'),
        t('ops', '跟进送医、记录事件经过'),
      ] };
    case 'child_lost':
      return { title: '儿童走失', severity: 'critical', tasks: [
        t('lifeguard', '封控池区出入口，水中与池岸分片搜寻'),
        t('frontdesk', '广播寻人、核对陪同人信息、调看监控'),
        t('cleaner', '搜寻更衣室、淋浴区与卫生间'),
        t('ops', '统筹寻人，10 分钟未找到立即报警并通知家长'),
      ] };
    case 'locker_dispute':
      return { title: '储物柜纠纷', severity: 'major', tasks: [
        t('frontdesk', '安抚双方，核对储物柜登记与备用钥匙'),
        t('maintenance', '到场技术性开锁/换锁，防止物品损坏'),
        t('ops', '调解并记录，必要时调整储物柜分配规则'),
      ] };
    case 'overbooking':
      return { title: '预约超额', severity: 'major', tasks: [
        t('frontdesk', '现场登记候补，按到场顺序安排入场'),
        t('lifeguard', '严控在池人数不超容量，超额泳客不得放行'),
        t('ops', '临时加开泳道/调整包场区域，无法入场者全额退费+补偿券'),
      ] };
    case 'equipment_fault':
      return { title: '设备故障', severity: 'major', tasks: [
        t('maintenance', '立即抢修、悬挂故障牌，必要时停机'),
        t('lifeguard', '相关泳区加密人工巡视'),
        t('cleaner', '故障区域防滑、清理积水'),
        t('ops', '评估是否需要限流或闭池'),
      ] };
    case 'medical':
      return { title: '突发医疗急救', severity: 'critical', tasks: [
        t('lifeguard', '立即施救并使用 AED，持续监护生命体征'),
        t('frontdesk', '拨打 120、开门引导救护车、联系家属'),
        t('cleaner', '清理急救通道'),
        t('ops', '跟进送医与家属安抚'),
      ] };
  }
}

const STAFF_ROLES: Role[] = ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'];
const LEVEL_MAP = { critical: 'critical', major: 'warning' } as const;

/** 创建事件：同场次各角色任务一并生成；保洁/维修任务同步进入工单 */
export function openIncident(db: DB, sessionId: string, type: IncidentType, titleOverride: string | undefined, description: string, reporter: string, severityOverride?: Incident['severity']): Incident {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const open = db.incidents.find((i) => i.sessionId === sessionId && i.type === type && i.status !== 'resolved');
  if (open) throw new HttpError(409, `同场次已有进行中的「${buildIncidentTasks(type).title}」事件，请直接协同处置 #${open.code}`);

  const tpl = buildIncidentTasks(type);
  const incident: Incident = {
    id: nextId('inc'), code: `INC-${db.counters.seq}`, sessionId, type,
    severity: severityOverride ?? tpl.severity,
    title: titleOverride || tpl.title,
    description, reportedAt: now(), reporter, status: 'open',
    tasks: tpl.tasks, actions: [{ id: nextId('ia'), at: now(), by: reporter, byRole: 'ops', content: `事件上报：${description}` }],
  };
  db.incidents.unshift(incident);

  pushNotification(db, {
    title: `【${session.label}】${incident.title} #${incident.code}`,
    body: description, level: LEVEL_MAP[incident.severity],
    roles: STAFF_ROLES, sessionId,
  });

  // 保洁/维修的处置项自动转工单，保证它们在自己的看板上看到
  for (const task of incident.tasks) {
    if (task.role === 'cleaner' || task.role === 'maintenance') {
      const wt: WorkTask = {
        id: nextId('wt'), sessionId, kind: task.role === 'maintenance' ? 'maintenance' : 'cleaning',
        title: `${incident.title}#${incident.code} · 处置`,
        detail: task.content, zoneId: 'all', assigneeRole: task.role,
        status: 'pending', createdAt: now(), source: 'incident', incidentId: incident.id,
      };
      db.workTasks.unshift(wt);
    }
  }
  return incident;
}

// ============ 预约 ============
export function createBooking(db: DB, userId: string, req: {
  kind: BookingKind; sessionId: string; zoneId: ZoneId; lane?: number; age: number;
  healthPledge: boolean; healthCode?: 'green' | 'expired' | 'none'; medicalCert?: boolean;
  withChildren: boolean; childCount: number; childCompanion?: string; childCompanionPhone?: string;
  swimLevel: Booking['swimLevel']; partySize?: number; childrenInParty?: number;
  contactName?: string; contactPhone?: string; orgName?: string;
  paymentMethod?: 'wallet' | 'cash' | 'voucher';
}) {
  const user = db.users.find((u) => u.id === userId)!;
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  if (session.poolStatus === 'closed') throw new HttpError(409, '该场次已闭池，暂不可预约');
  const zone = db.zones.find((z) => z.id === req.zoneId);
  if (!zone) throw new HttpError(404, '泳区不存在');
  if (!req.healthPledge) throw new HttpError(400, '必须勾选健康承诺后方可预约');
  if (req.age < 14 && !(req.withChildren || req.kind === 'parent_child'))
    throw new HttpError(400, '14 岁以下儿童须由成人陪同，按亲子时段预约');
  if (zone.requireCert && !user.deepCert)
    throw new HttpError(403, '深水区须持深水合格证，您可先在前台进行 200 米测试');

  const partySize = req.kind === 'group' || req.kind === 'institution_rental'
    ? Math.max(1, req.partySize ?? 1)
    : req.kind === 'parent_child' ? 1 + Math.max(0, req.childCount) : 1;
  const childrenInParty = req.kind === 'parent_child' ? Math.max(0, req.childCount) : (req.childrenInParty ?? 0);

  if (req.kind === 'institution_rental') {
    if (!req.orgName || !req.contactName || !req.contactPhone) throw new HttpError(400, '机构包场须填写机构名称、联系人与电话');
    if (partySize < 10) throw new HttpError(400, '机构包场不少于 10 人，普通团体请选团体预约');
  }
  if (req.kind === 'group' && partySize < 5) throw new HttpError(400, '团体预约不少于 5 人');

  // 泳道/锁区冲突
  const { hits: lockHits } = zoneLocked(db, session, req.zoneId, req.lane);
  if (lockHits.length) throw new HttpError(409, `该泳道/区域已被锁定：${lockHits.map((l) => l.title).join('；')}`);

  const { seats: locked } = zoneLocked(db, session, req.zoneId);
  const { inPool, booked } = zoneCounts(db, req.sessionId, req.zoneId);
  const remaining = zone.capacity - locked - inPool - booked;
  const overCapacity = remaining < partySize;

  const paymentMethod = req.paymentMethod ?? (req.kind === 'institution_rental' ? 'cash' : 'wallet');
  const amount = priceOf(req.kind, partySize, req.childCount, user.memberTier);

  if (amount > 0) {
    if (paymentMethod === 'wallet') {
      if ((user.walletBalance ?? 0) < amount) throw new HttpError(402, '储值余额不足，请先在「我的钱包」充值');
      user.walletBalance = (user.walletBalance ?? 0) - amount;
    } else if (paymentMethod === 'voucher') {
      if ((user.compVouchers ?? 0) < 1) throw new HttpError(402, '没有可用的补偿券');
      user.compVouchers = (user.compVouchers ?? 0) - 1;
    }
  }

  const booking: Booking = {
    id: nextId('bk'), code: `B-${db.counters.seq}`, userId, kind: req.kind, sessionId: req.sessionId,
    zoneId: req.zoneId, lane: req.lane, periodLabel: `${session.start}-${session.start.slice(0, 2)}:00`,
    age: req.age, healthPledge: true, healthCode: req.healthCode, medicalCert: req.medicalCert,
    withChildren: req.withChildren, childCount: req.childCount,
    childCompanion: req.childCompanion, childCompanionPhone: req.childCompanionPhone,
    swimLevel: req.swimLevel, partySize, childrenInParty,
    contactName: req.contactName, contactPhone: req.contactPhone, orgName: req.orgName,
    status: 'booked', paidAmount: amount, paymentMethod, createdAt: now(),
  };
  // 修正时段标签
  booking.periodLabel = `${session.start}-${session.end.split(':')[0]}:00`;
  db.bookings.unshift(booking);

  if (amount > 0) {
    db.walletTxns.unshift({
      id: nextId('tx'), at: now(), userId, amount: -amount,
      reason: `预约 ${booking.code} ${zone.name}（${paymentMethod === 'wallet' ? '储值' : paymentMethod === 'voucher' ? '补偿券' : '现金/对公'}）`,
      sessionId: session.id,
    });
  }

  // 机构包场同时写入商业锁区
  let conflictWarnings: string[] = [];
  if (req.kind === 'institution_rental') {
    const lock = {
      id: nextId('lock'), zoneId: req.zoneId, lane: req.lane, reason: 'institution_rental' as const,
      title: `${req.orgName}·包场`, contactName: req.contactName!, contactPhone: req.contactPhone!,
      capacity: partySize, isCommercial: true, bookingId: booking.id,
    };
    session.locks.push(lock);
    conflictWarnings = lockConflicts(db, session, lock);
    pushNotification(db, {
      title: `商业包场申请：${req.orgName}（${session.label}）`,
      body: `包场 ${zone.name} ${partySize} 人，联系人 ${req.contactName}。${conflictWarnings.length ? '检测到冲突：' + conflictWarnings.join('；') : '无直接冲突。'}`,
      level: conflictWarnings.length ? 'critical' : 'warning', roles: ['ops', 'frontdesk'], sessionId: session.id,
    });
  }

  // 预约超额自动立案，各角色围绕同场次处理
  if (overCapacity) {
    const inc = openIncident(db, session.id, 'overbooking', undefined,
      `${zone.name} 预约超出可用容量 ${zone.capacity - locked} 人（已锁 ${locked}），最新预约 ${booking.code}，请尽快加道/分流。`,
      user.name);
    pushNotification(db, {
      title: `预约超额预警 ${session.label}`, level: 'critical', roles: ['ops', 'frontdesk', 'lifeguard'],
      body: `${zone.name} 已预约 ${booked + partySize} 人 / 可用 ${zone.capacity - locked} 人，事件 #${inc.code} 已立案。`,
      sessionId: session.id,
    });
  }

  return { booking, overCapacity, conflictWarnings };
}

// ============ 前台核验入场 ============
export function checkIn(db: DB, bookingId: string, operator: string, req: {
  healthCode: 'green' | 'expired' | 'none'; medicalCert: boolean;
  childCompanion: string; childCompanionPhone: string; lockerNo: string;
}) {
  const b = db.bookings.find((x) => x.id === bookingId);
  if (!b) throw new HttpError(404, '预约不存在');
  if (b.status !== 'booked') throw new HttpError(409, `当前状态不可入场：${b.status}`);
  const session = db.sessions.find((s) => s.id === b.sessionId)!;
  if (session.poolStatus === 'closed') throw new HttpError(409, '本场已闭池，停止入场');
  if (session.poolStatus === 'restricted') throw new HttpError(409, `本场限流中：${session.statusReason || '水质/天气异常待复测'}，暂不放行`);
  if (req.healthCode !== 'green') throw new HttpError(400, '健康码非绿码/已过期，请引导居民更新后再核验');

  const user = db.users.find((u) => u.id === b.userId)!;
  const zone = db.zones.find((z) => z.id === b.zoneId)!;
  if (zone.requireCert && !user.deepCert) throw new HttpError(403, '该泳客无深水合格证，不得进入深水区');
  if (b.withChildren || (b.childrenInParty ?? 0) > 0) {
    if (!req.childCompanion || !req.childCompanionPhone) throw new HttpError(400, '带儿童入场必须登记陪同人及联系电话');
  }
  if (!req.lockerNo.trim()) throw new HttpError(400, '请分配储物柜号');
  const clash = db.bookings.find((x) => x.status === 'checked_in' && x.lockerNo === req.lockerNo.trim());
  if (clash) throw new HttpError(409, `储物柜 ${req.lockerNo} 已被预约 ${clash.code} 使用，请先处理储物柜纠纷或换柜`);

  // 在池人数硬上限（容量扣除锁区）
  const { seats: locked } = zoneLocked(db, session, b.zoneId);
  const { inPool } = zoneCounts(db, session.id, b.zoneId);
  if (inPool + Math.max(1, b.partySize) > zone.capacity - locked) {
    const inc = db.incidents.find((i) => i.sessionId === session.id && i.type === 'overbooking' && i.status !== 'resolved')
      ?? openIncident(db, session.id, 'overbooking', undefined,
        `${zone.name} 入场核验时在池人数将达 ${inPool + b.partySize}，超出可用容量 ${zone.capacity - locked}，预约 ${b.code} 暂缓入场。`, operator);
    throw new HttpError(429, `${zone.name} 在池人数已达上限，请运营加道/分流后再放行（事件 #${inc.code}）`);
  }

  b.status = 'checked_in';
  b.checkedInAt = now();
  b.checkedInBy = operator;
  b.healthCode = req.healthCode;
  b.medicalCert = req.medicalCert;
  b.childCompanion = req.childCompanion || b.childCompanion;
  b.childCompanionPhone = req.childCompanionPhone || b.childCompanionPhone;
  b.lockerNo = req.lockerNo.trim();
  return b;
}

// ============ 水质检测 ============
export function addWaterReading(db: DB, recorder: string, req: { sessionId: string; tempC: number; freeChlorine: number; turbidity: number; ph: number; note?: string }) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  for (const [k, v] of Object.entries({ tempC: req.tempC, freeChlorine: req.freeChlorine, turbidity: req.turbidity, ph: req.ph })) {
    if (typeof v !== 'number' || Number.isNaN(v)) throw new HttpError(400, `${k} 数值不合法`);
  }
  const ev = evaluateWater(req);
  const reading: WaterReading = {
    id: nextId('w'), sessionId: req.sessionId, at: now(),
    tempC: req.tempC, freeChlorine: req.freeChlorine, turbidity: req.turbidity, ph: req.ph,
    recorder, abnormal: ev.abnormal, abnormalFields: ev.fields, note: req.note,
  };
  db.waterReadings.unshift(reading);

  if (ev.abnormal) {
    const open = db.incidents.find((i) => i.sessionId === session.id && i.type === 'water_abnormal' && i.status !== 'resolved');
    let inc = open;
    if (!inc) {
      inc = openIncident(db, session.id, 'water_abnormal', undefined,
        `检测超标：${ev.fields.join('；')}。记录人 ${recorder}。`, recorder);
      reading.eventId = inc.id;
      // 自动限流：异常期间暂停新入场，等待运营复测/闭池决策
      if (session.poolStatus === 'normal') {
        session.poolStatus = 'restricted';
        session.statusReason = '水质异常，暂停新入场，等待复测';
        session.requireWaterRetest = true;
      }
      db.workTasks.unshift({
        id: nextId('wt'), sessionId: session.id, kind: 'disinfection',
        title: '水质异常处置：加药/反冲洗并复测', detail: ev.fields.join('；'),
        zoneId: 'all', assigneeRole: 'maintenance', status: 'pending',
        createdAt: now(), source: 'incident', incidentId: inc.id,
      });
    } else {
      inc.actions.push({ id: nextId('ia'), at: now(), by: recorder, byRole: 'lifeguard', content: `复测数据：${ev.fields.join('；')}（仍异常）` });
      reading.eventId = inc.id;
    }
    pushNotification(db, {
      title: `水质异常 ${session.label}`, body: ev.fields.join('；'),
      level: 'critical', roles: ['ops', 'lifeguard', 'maintenance', 'frontdesk'], sessionId: session.id,
    });
  } else {
    const open = db.incidents.find((i) => i.sessionId === session.id && i.type === 'water_abnormal' && i.status !== 'resolved');
    if (open) {
      open.actions.push({ id: nextId('ia'), at: now(), by: recorder, byRole: 'lifeguard',
        content: `复测达标：水温 ${req.tempC}°C / 余氯 ${req.freeChlorine}mg/L / 浊度 ${req.turbidity}NTU / pH ${req.ph}` });
      pushNotification(db, {
        title: `水质复测已达标 ${session.label}`, body: '请运营确认后恢复开放。',
        level: 'info', roles: ['ops', 'lifeguard', 'maintenance'], sessionId: session.id,
      });
    }
  }
  return reading;
}

// ============ 巡查 ============
const PATROL_ASSIGNEE: Record<string, Role> = {
  diving: 'lifeguard', child_alone: 'lifeguard', wet_floor: 'cleaner',
  shower_crowd: 'cleaner', water_quality: 'maintenance', guard_missing: 'ops', other: 'ops',
};

export function addPatrolIssue(db: DB, reporter: string, req: {
  sessionId: string; type: PatrolIssue['type']; severity: PatrolIssue['severity'];
  description: string; location: string; assigneeRole?: Role;
}) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const role = req.assigneeRole ?? PATROL_ASSIGNEE[req.type] ?? 'ops';
  const assignee = db.users.find((u) => u.role === role);
  const issue: PatrolIssue = {
    id: nextId('pi'), sessionId: req.sessionId, at: now(),
    type: req.type, severity: req.severity, description: req.description, location: req.location,
    reporter, assigneeRole: role, assigneeName: assignee?.name, status: 'open',
  };
  db.patrolIssues.unshift(issue);
  if (role === 'cleaner' || role === 'maintenance') {
    db.workTasks.unshift({
      id: nextId('wt'), sessionId: req.sessionId,
      kind: role === 'maintenance' ? (req.type === 'water_quality' ? 'disinfection' : 'maintenance') : 'cleaning',
      title: `巡查问题处置：${req.location}`, detail: req.description, zoneId: 'all',
      assigneeRole: role, status: 'pending', createdAt: now(), source: 'patrol',
    });
  }
  pushNotification(db, {
    title: `巡查上报（${session.label}）`, body: `${req.location}：${req.description}`,
    level: req.severity === 'critical' ? 'critical' : 'warning', roles: [role, 'ops'], sessionId: session.id,
  });
  return issue;
}

// ============ 闭池 / 恢复开放（联动编排） ============
export function changePoolStatus(db: DB, operator: string, req: {
  sessionId: string; status: PoolStatus; reason?: string; cause?: IncidentType | 'other';
  refund?: boolean; compVoucher?: boolean; notifyResidents?: boolean; requireWaterRetest?: boolean;
}) {
  const session = db.sessions.find((s) => s.id === req.sessionId);
  if (!session) throw new HttpError(404, '场次不存在');
  const prev = session.poolStatus;

  if (req.status === 'normal') {
    if (prev !== 'closed' && prev !== 'restricted') return { session, reopened: false as const };
    if (session.requireWaterRetest && session.closedAt) {
      const pass = db.waterReadings.find((w) => w.sessionId === session.id && w.at > session.closedAt! && !w.abnormal);
      if (!pass) throw new HttpError(409, '闭池原因涉及水质，须先完成一次达标复测（救生员端录入合格水质数据）');
    }
    session.poolStatus = 'normal';
    session.statusReason = undefined;
    session.reopenedAt = now();
    session.requireWaterRetest = false;
    pushNotification(db, {
      title: `恢复开放：${session.label}`, level: 'info', roles: [],
      body: `水质复测合格、现场处置完成，泳池恢复开放。此前闭池退费与补偿券已发放，居民可重新预约后续场次。`,
      sessionId: session.id,
    });
    pushNotification(db, {
      title: `恢复开放提醒：${session.label}`, level: 'info', roles: ['lifeguard', 'frontdesk', 'cleaner'],
      body: '请救生员重新到岗、前台恢复核验、保洁完成开场清洁。', sessionId: session.id,
    });
    return { session, reopened: true as const };
  }

  if (req.status === 'restricted') {
    session.poolStatus = 'restricted';
    session.statusReason = req.reason || '现场异常，限流管理';
    pushNotification(db, {
      title: `限流：${session.label}`, level: 'warning', roles: STAFF_ROLES,
      body: session.statusReason, sessionId: session.id,
    });
    return { session, reopened: false as const };
  }

  // ---- 闭池：一次性联动退费 / 补偿券 / 复测 / 救生巡查 / 居民通知 ----
  if (prev === 'closed') throw new HttpError(409, '该场次已处于闭池状态');
  session.poolStatus = 'closed';
  session.statusReason = req.reason || '临时闭池';
  session.closedAt = now();
  session.settled = true;
  const waterCause = req.cause === 'water_abnormal' || /水质|余氯|浊度|水温/.test(req.reason || '');
  session.requireWaterRetest = req.requireWaterRetest ?? waterCause;

  const affected = db.bookings.filter(
    (b) => b.sessionId === session.id && (b.status === 'booked' || b.status === 'checked_in'),
  );
  let refundCount = 0;
  let voucherCount = 0;

  for (const b of affected) {
    const u = db.users.find((x) => x.id === b.userId);
    if (!u) continue;
    if (req.refund && b.paidAmount > 0) {
      u.walletBalance = (u.walletBalance ?? 0) + b.paidAmount;
      db.walletTxns.unshift({
        id: nextId('tx'), at: now(), userId: u.id, amount: b.paidAmount,
        reason: `闭池退费 ${b.code}（${session.statusReason}）`, sessionId: session.id,
      });
      if (b.paymentMethod === 'voucher') u.compVouchers = (u.compVouchers ?? 0) + 1;
      refundCount++;
    }
    if (req.compVoucher) {
      u.compVouchers = (u.compVouchers ?? 0) + 1;
      voucherCount++;
      b.status = 'compensated';
    } else if (req.refund) {
      b.status = 'refunded';
    }
    if (req.notifyResidents) {
      pushNotification(db, {
        title: `闭池通知：${session.label} 已${req.refund ? '退费' : '取消'}${req.compVoucher ? '并发放补偿券' : ''}`,
        body: `原因：${session.statusReason}。${req.refund ? `${b.paidAmount} 元已原路退回您的账户` : ''}${req.compVoucher ? '另发放 1 张补偿券（可抵一次入场）' : ''}。恢复开放时间将另行通知。`,
        level: 'critical', roles: [], userId: u.id, sessionId: session.id,
      });
    }
  }

  if (req.notifyResidents) {
    pushNotification(db, {
      title: `【闭池】${session.label}`, level: 'critical', roles: [],
      body: `${session.statusReason}。已预约居民${req.refund ? '退费' : ''}${req.compVoucher ? '+补偿券' : ''}处理中，开放时间另行通知。`,
      sessionId: session.id,
    });
  }

  // 救生巡查同步：在岗救生员结束当前站位（清场）
  for (const d of db.guardDuties) {
    if (d.sessionId === session.id && !d.end) {
      d.end = now();
      d.note = `闭池清场：${session.statusReason}`;
    }
  }
  // 维修：复测/消毒；保洁：清场清洁
  db.workTasks.unshift({
    id: nextId('wt'), sessionId: session.id, kind: 'disinfection',
    title: '闭池后全面消毒与水质复测', detail: `闭池原因：${session.statusReason}。恢复开放前须提交达标水质读数。`,
    zoneId: 'all', assigneeRole: 'maintenance', status: 'pending', createdAt: now(), source: 'incident',
  });
  db.workTasks.unshift({
    id: nextId('wt'), sessionId: session.id, kind: 'cleaning',
    title: '闭池清场清洁', detail: '清场后清洁池岸、淋浴区、更衣室，检查遗落物品。',
    zoneId: 'all', assigneeRole: 'cleaner', status: 'pending', createdAt: now(), source: 'incident',
  });

  // 关联事件追加联动记录
  if (req.cause && req.cause !== 'other') {
    const inc = db.incidents.find((i) => i.sessionId === session.id && i.type === req.cause && i.status !== 'resolved');
    if (inc) {
      inc.actions.push({
        id: nextId('ia'), at: now(), by: operator, byRole: 'ops',
        content: `已执行闭池联动：退费 ${refundCount} 笔、补偿券 ${voucherCount} 张、复测工单与清场清洁已派发、居民通知已发送。`,
      });
    }
  }

  pushNotification(db, {
    title: `闭池处置完成：${session.label}`, level: 'critical', roles: STAFF_ROLES,
    body: `退费 ${refundCount} 笔 / 补偿券 ${voucherCount} 张 / 复测与清场工单已派发 / 救生岗已撤。`, sessionId: session.id,
  });

  return { session, refundCount, voucherCount, affected: affected.length, reopened: false as const };
}

// ============ 实时看板 ============
export function pickCurrentSession(db: DB): Session {
  const hm = new Date().toTimeString().slice(0, 5);
  const todayStr = new Date().toISOString().slice(0, 10);
  const todays = db.sessions.filter((s) => s.date === todayStr);
  return todays.find((s) => hm >= s.start && hm <= s.end)
    ?? todays.find((s) => hm < s.start)
    ?? todays[0]
    ?? db.sessions[0];
}

export function liveBoard(db: DB, sessionId?: string): LiveBoard {
  const session = (sessionId && db.sessions.find((s) => s.id === sessionId)) || pickCurrentSession(db);
  const zones: ZoneLiveStat[] = db.zones.map((z) => {
    const { inPool, booked, children, deepHolders } = zoneCounts(db, session.id, z.id);
    const { seats: locked } = zoneLocked(db, session, z.id);
    const usable = Math.max(1, z.capacity - locked);
    return {
      zoneId: z.id, name: z.name, capacity: z.capacity, inPool, booked, children, locked,
      deepCertRequired: z.requireCert, deepCertHoldersInPool: deepHolders,
      occupancyPct: Math.round((inPool / usable) * 100),
    };
  });
  const water = db.waterReadings.find((w) => w.sessionId === session.id) ?? null;
  const openIncidents = db.incidents.filter((i) => i.sessionId === session.id && i.status !== 'resolved');
  const guardOnDuty = db.guardDuties
    .filter((d) => d.sessionId === session.id && !d.end)
    .map((d) => ({
      post: d.post as GuardPost, postLabel: GUARD_POST_LABEL[d.post],
      guardName: db.users.find((u) => u.id === d.guardUserId)?.name ?? '未知', startedAt: d.start,
    }));
  return {
    session,
    zones,
    totalInPool: zones.reduce((s, z) => s + z.inPool, 0),
    totalCapacity: db.zones.reduce((s, z) => s + z.capacity, 0),
    water, openIncidents, guardOnDuty,
    poolStatus: session.poolStatus,
    thunderAlert: openIncidents.some((i) => i.type === 'thunderstorm'),
    equipment: db.equipment,
  };
}

/** 场次完整状态：预约 → 入场 → 巡查 → 清场 */
export function sessionDetail(db: DB, id: string) {
  const session = db.sessions.find((s) => s.id === id);
  if (!session) throw new HttpError(404, '场次不存在');
  const bookings = db.bookings.filter((b) => b.sessionId === id).map((b) => ({
    ...b, userName: db.users.find((u) => u.id === b.userId)?.name ?? '已删除用户',
    userPhone: db.users.find((u) => u.id === b.userId)?.phone,
    memberTier: db.users.find((u) => u.id === b.userId)?.memberTier,
  }));
  const conflicts = session.locks.flatMap((l) =>
    lockConflicts(db, session, l).map((message) => ({ lockTitle: l.title, message })));
  const hm = new Date().toTimeString().slice(0, 5);
  const stage = session.poolStatus === 'closed' ? 'closed'
    : hm < session.start ? 'booking' : hm > session.end ? 'cleared' : 'live';
  return {
    session, stage,
    bookings,
    locks: session.locks,
    waterReadings: db.waterReadings.filter((w) => w.sessionId === id),
    patrolIssues: db.patrolIssues.filter((p) => p.sessionId === id),
    incidents: db.incidents.filter((i) => i.sessionId === id),
    guardDuties: db.guardDuties.filter((d) => d.sessionId === id).map((d) => ({
      ...d, guardName: db.users.find((u) => u.id === d.guardUserId)?.name ?? '未知',
    })),
    workTasks: db.workTasks.filter((w) => w.sessionId === id),
    conflicts,
    counts: {
      booked: bookings.filter((b) => b.status === 'booked').length,
      checkedIn: bookings.filter((b) => b.status === 'checked_in').length,
      refunded: bookings.filter((b) => b.status === 'refunded' || b.status === 'compensated').length,
      peopleInPool: bookings.filter((b) => b.status === 'checked_in').reduce((s, b) => s + Math.max(1, b.partySize), 0),
    },
  };
}

// ============ 派生：全局冲突摘要 ============
export function conflictSummary(db: DB) {
  const out: { sessionId: string; sessionLabel: string; message: string }[] = [];
  for (const s of db.sessions) {
    for (const l of s.locks) {
      for (const message of lockConflicts(db, s, l)) {
        out.push({ sessionId: s.id, sessionLabel: s.label, message: `【${l.title}】${message}` });
      }
    }
  }
  return out;
}

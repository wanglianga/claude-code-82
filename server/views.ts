import type {
  DB, User, Role, Session, Booking, Notification, Incident, WorkTask, PatrolIssue,
  WaterReading, GuardDuty, Complaint, CoachingLesson, LiveBoard, ZoneLock,
  StateView, PatronCard,
} from '../shared/types.js';
import { liveBoard, conflictSummary, sessionDetail } from './domain.js';

export type { StateView, PatronCard };

/**
 * 服务端角色视图：/api/state 绝不返回全库快照，而是按会话用户的角色裁剪。
 * 原则：
 *  - 居民：仅本人预约/钱包流水/投诉/个人通知，其余居民 PII 一律不可见；
 *  - 前台：本场预约核验所需的预约与泳客联系信息，不见钱包流水；
 *  - 救生员：人数/儿童/深水权限聚合（看板）与水质设备，不见任何钱包与泳客联系方式；
 *  - 保洁/维修：仅本岗工单、分派给本岗的巡查、需要本岗参与的事件；
 *  - 运营：全量业务视图（处置退费/投诉/冲突所必需）。
 */

const STAFF: Role[] = ['frontdesk', 'lifeguard', 'cleaner', 'maintenance', 'ops'];

function patronCard(u: User): PatronCard {
  return { id: u.id, name: u.name, role: u.role, phone: u.phone, memberTier: u.memberTier, deepCert: u.deepCert };
}

function visibleNotification(n: Notification, role: Role, userId: string) {
  // 运营负责退款/通知核对，可见全部（含逐人通知）；个人通知其余角色仅本人可见
  if (role === 'ops') return true;
  if (n.userId) return n.userId === userId;
  return n.roles.length === 0 || n.roles.includes(role);
}

/** 非前台/运营角色不得看到锁区联系人（机构对接电话属于运营/前台职责数据） */
function safeLock(l: ZoneLock): ZoneLock {
  return { ...l, contactName: '', contactPhone: '' };
}

/** 居民侧锁区：只保留“区域/泳道被占用及名额数”，标题泛化，不暴露机构名称等第三方商业信息 */
function residentLock(l: ZoneLock): ZoneLock {
  const genericTitle =
    l.reason === 'coaching' ? '教学专用道'
    : l.reason === 'maintenance' ? '设备维护占用'
    : '该区域已被包场';
  return { ...l, title: genericTitle, contactName: '', contactPhone: '', bookingId: undefined };
}

function safeSession(s: Session, viewer: User): Session {
  if (viewer.role === 'ops' || viewer.role === 'frontdesk') return s;
  if (viewer.role === 'resident') return { ...s, locks: s.locks.map(residentLock) };
  return { ...s, locks: s.locks.map(safeLock) };
}

function safeLesson(l: CoachingLesson, viewer: User): CoachingLesson {
  // 学员名单属于居民 PII：仅保留本人 id（用于“已报名”状态），其余学员不可见
  if (viewer.role === 'resident') return { ...l, studentIds: l.studentIds.filter((id) => id === viewer.id) };
  return l;
}

function safeBoard(b: LiveBoard, viewer: User): LiveBoard {
  const session = safeSession(b.session, viewer);
  const role = viewer.role;
  if (role === 'resident') {
    // 居民看板：仅泳区聚合与场次状态；水质/事件/排班/设备均属现场运营数据，不进居民快照
    return {
      ...b, session, water: null, openIncidents: [], guardOnDuty: [], equipment: [],
    };
  }
  if (role === 'ops' || role === 'lifeguard') {
    // 救生看板需要设备状态；运营全量
    return { ...b, session };
  }
  if (role === 'frontdesk') {
    // 前台只需泳区聚合与未结事件，不看设备清单/救生排班明细
    return { ...b, session, guardOnDuty: [], equipment: [] };
  }
  // 保洁/维修：只看需要本岗参与的事件；设备清单仅维修需要
  return {
    ...b,
    session,
    openIncidents: b.openIncidents.filter((i) => i.tasks.some((t) => t.role === role)),
    equipment: role === 'maintenance' ? b.equipment : [],
  };
}

/** 闭池档案裁剪：运营全量；居民仅见本人受影响条目；其他员工（含前台）只见原因/状态/计数，不见逐人退款 */
function sanitizeClosure(db: DB, r: DB['closureRecords'][number], viewer: User) {
  const role = viewer.role;
  if (role === 'ops') return r;
  if (role === 'resident') {
    const mine = r.affected.filter((a) => a.userId === viewer.id);
    if (mine.length === 0) return null;
    return { ...r, affected: mine.map((a) => ({ ...a, userName: viewer.name })) };
  }
  // 救生/保洁/维修/前台：知道每轮闭池原因、复测与恢复状态、本岗相关工单数即可
  const myTaskIds = r.taskIds.filter((tid) => db.workTasks.find((t) => t.id === tid)?.assigneeRole === role);
  return {
    ...r, affected: [], announcementIds: [],
    refundTotal: r.refundCount, // 不含逐人金额，保留笔数
    taskIds: myTaskIds,
  };
}

export function buildStateView(db: DB, viewer: User): StateView {
  const role = viewer.role;
  const isOps = role === 'ops';
  const isFrontdesk = role === 'frontdesk';
  const isLifeguard = role === 'lifeguard';
  const isMaintenance = role === 'maintenance';
  const isCleaner = role === 'cleaner';
  const isResident = role === 'resident';

  // ---- 人员目录 ----
  let users: PatronCard[] = [];
  if (isOps) {
    users = db.users.map(patronCard);
  } else if (isFrontdesk) {
    // 仅核验需要联系的泳客（有预约记录的居民），不含余额/补偿券
    const ids = new Set(db.bookings.map((b) => b.userId));
    users = db.users.filter((u) => ids.has(u.id)).map(patronCard);
  } else if (isLifeguard) {
    // 仅救生员名册（换岗下拉用），无电话
    users = db.users.filter((u) => u.role === 'lifeguard').map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  // ---- 预约 ----
  let bookings: Booking[] = [];
  if (isOps || isFrontdesk) bookings = db.bookings;
  else if (isResident) bookings = db.bookings.filter((b) => b.userId === viewer.id);
  // 救生/保洁/维修不需要逐笔预约（人数与深水权限只经看板聚合暴露）

  // ---- 水质 / 设备 ----
  const canWater = isOps || isLifeguard || isMaintenance;
  const waterReadings = canWater ? db.waterReadings : [];
  const equipment = isOps || isLifeguard || isMaintenance ? db.equipment : [];

  // ---- 救生站位 ----
  const guardDuties = isOps || isLifeguard ? db.guardDuties : [];

  // ---- 巡查 ----
  let patrolIssues: PatrolIssue[] = [];
  if (isOps || isLifeguard || isFrontdesk) patrolIssues = db.patrolIssues;
  else if (isCleaner || isMaintenance) patrolIssues = db.patrolIssues.filter((p) => p.assigneeRole === role);

  // ---- 事件协同 ----
  let incidents: Incident[] = [];
  if (isOps || isFrontdesk || isLifeguard) incidents = db.incidents;
  else if (isCleaner || isMaintenance)
    incidents = db.incidents.filter((i) => i.tasks.some((t) => t.role === role));
  // 居民不直接暴露事件流（其知情范围经通知/通告）

  // ---- 工单 ----
  let workTasks: WorkTask[] = [];
  if (isOps) workTasks = db.workTasks;
  else if (isCleaner || isMaintenance) workTasks = db.workTasks.filter((t) => t.assigneeRole === role);

  // ---- 投诉 ----
  const complaints = isOps
    ? db.complaints
    : isResident ? db.complaints.filter((c) => c.userId === viewer.id) : [];

  // ---- 通知：广播 + 角色通知 + 个人通知 ----
  const notifications = db.notifications.filter((n) => visibleNotification(n, role, viewer.id));

  // ---- 钱包流水：仅本人；运营因退费处置需要可见 ----
  const walletTxns = isOps
    ? db.walletTxns
    : isResident ? db.walletTxns.filter((t) => t.userId === viewer.id) : [];

  // ---- 教练课 ----
  const lessons = (isOps || isResident) ? db.lessons.map((l) => safeLesson(l, viewer)) : [];

  const sessions = db.sessions.map((s) => safeSession(s, viewer));
  const boards = db.sessions.map((s) => safeBoard(liveBoard(db, s.id), viewer));
  const conflicts = isOps || isFrontdesk ? conflictSummary(db) : [];

  // ---- 闭池档案：不可变快照，按角色裁剪（居民仅本人条目；救生/保洁/维修不见逐人金额） ----
  const closureRecords = db.closureRecords
    .flatMap((r) => {
      const v = sanitizeClosure(db, r, viewer);
      return v ? [v] : [];
    });

  return {
    viewerRole: role,
    users, zones: db.zones, sessions, bookings, waterReadings, equipment,
    guardDuties, patrolIssues, incidents, workTasks, complaints, notifications,
    walletTxns, lessons, closureRecords, boards, conflicts,
  };
}

/** GET /api/sessions/:id 同样按角色裁剪（前端虽走 /state，接口本身也不得泄露） */
export function sanitizeSessionDetail(detail: ReturnType<typeof sessionDetail>, viewer: User, db: DB) {
  const role = viewer.role;
  const isOps = role === 'ops';
  const isFrontdesk = role === 'frontdesk';
  const bookings =
    isOps || isFrontdesk ? detail.bookings
    : role === 'resident' ? detail.bookings.filter((b) => b.userId === viewer.id)
    : [];
  const closureRecords = (detail.closureRecords ?? [])
    .flatMap((r) => { const v = sanitizeClosure(db, r, viewer); return v ? [v] : []; });
  return {
    ...detail,
    session: safeSession(detail.session, viewer),
    bookings,
    closureRecords,
    locks: role === 'ops' || isFrontdesk ? detail.locks : detail.locks.map(safeLock),
    waterReadings: isOps || role === 'lifeguard' || role === 'maintenance' ? detail.waterReadings : [],
    patrolIssues:
      isOps || role === 'lifeguard' || isFrontdesk ? detail.patrolIssues
      : role === 'cleaner' || role === 'maintenance' ? detail.patrolIssues.filter((p) => p.assigneeRole === role)
      : [],
    incidents:
      isOps || isFrontdesk || role === 'lifeguard' ? detail.incidents
      : role === 'cleaner' || role === 'maintenance' ? detail.incidents.filter((i) => i.tasks.some((t) => t.role === role))
      : [],
    guardDuties: isOps || role === 'lifeguard' ? detail.guardDuties : [],
    workTasks: isOps ? detail.workTasks : (role === 'cleaner' || role === 'maintenance' ? detail.workTasks.filter((t) => t.assigneeRole === role) : []),
    // 冲突协调是运营/前台职责，其他角色（含居民）不返回冲突明细
    conflicts: isOps || isFrontdesk ? detail.conflicts : [],
  };
}

export function visibleConflictsFor(db: DB, role: Role) {
  return role === 'ops' || role === 'frontdesk' ? conflictSummary(db) : [];
}

export { STAFF };

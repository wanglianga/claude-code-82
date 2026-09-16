// ============ 领域模型（前后端共享） ============

export type Role = 'resident' | 'frontdesk' | 'lifeguard' | 'cleaner' | 'maintenance' | 'ops';

export const ROLE_LABEL: Record<Role, string> = {
  resident: '居民',
  frontdesk: '前台',
  lifeguard: '救生员',
  cleaner: '保洁',
  maintenance: '维修',
  ops: '社区运营',
};

export type ZoneId = 'training' | 'family' | 'deep' | 'shallow';

export interface Zone {
  id: ZoneId;
  name: string;
  capacity: number;
  rules: string[];
  risk: 'low' | 'medium' | 'high';
  /** 需要深水合格证 */
  requireCert: boolean;
  /** 是否为儿童区（统计儿童人数） */
  isChildArea?: boolean;
}

export type MemberTier = 'normal' | 'silver' | 'gold' | 'guest' | 'institution';
export type SwimLevel = 'none' | 'beginner' | 'intermediate' | 'advanced';

export interface User {
  id: string;
  username: string;
  password: string;
  name: string;
  role: Role;
  phone?: string;
  memberTier?: MemberTier;
  /** 深水合格证 */
  deepCert?: boolean;
  walletBalance?: number;
  /** 补偿券：每张可抵一次入场 */
  compVouchers?: number;
  age?: number;
}

/** 预约类型：居民个人 / 亲子 / 老人晨泳公益 / 教练课 / 团体 / 机构包场 / 访客 */
export type BookingKind =
  | 'personal'
  | 'parent_child'
  | 'elder_morning'
  | 'coaching'
  | 'group'
  | 'institution_rental'
  | 'guest';

export type BookingStatus =
  | 'booked'        // 已预约
  | 'checked_in'    // 已入场
  | 'no_show'       // 爽约
  | 'cancelled'     // 已取消
  | 'refunded'      // 已退费（闭池）
  | 'compensated'; // 已补偿（退费+券）

export interface Booking {
  id: string;
  code: string;              // 预约码 B-xxxx
  userId: string;            // 预约人（机构包场为联系人账号）
  kind: BookingKind;
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;             // 泳道（个人预约泳道）
  periodLabel: string;       // 入场时段文案，如 09:00-10:00
  age: number;
  healthPledge: boolean;     // 健康承诺
  healthCode?: 'green' | 'expired' | 'none'; // 健康码状态（前台核验用）
  medicalCert?: boolean;     // 体检证明
  withChildren: boolean;
  childCount: number;
  childCompanion?: string;   // 儿童陪同人
  childCompanionPhone?: string;
  swimLevel: SwimLevel;
  partySize: number;         // 团体/包场总人数（含成人儿童）
  childrenInParty?: number;
  contactName?: string;
  contactPhone?: string;
  orgName?: string;          // 培训机构名称
  status: BookingStatus;
  paidAmount: number;
  paymentMethod: 'wallet' | 'cash' | 'voucher';
  lockerNo?: string;
  checkedInAt?: string;
  checkedInBy?: string;
  createdAt: string;
  /** 历次闭池档案 id（退费/补偿联动时追加，可多次） */
  closureIds?: string[];
}

export type PoolStatus = 'normal' | 'restricted' | 'closed';

export interface Session {
  id: string;
  label: string;            // 如 09-10 晨泳场
  date: string;             // YYYY-MM-DD
  start: string;
  end: string;
  poolStatus: PoolStatus;
  statusReason?: string;
  /** 关闭/限流时是否已完成退费与通知联动 */
  settled?: boolean;
  closedAt?: string;
  reopenedAt?: string;
  /** 闭池时是否要求水质复测合格后方可恢复 */
  requireWaterRetest?: boolean;
  /** 居民公益时段（老人晨泳等），商业包场与其冲突时预警 */
  publicWelfare?: boolean;
  maxCapacity: number;
  /** 本场锁定的泳区/泳道（机构包场、教练课等商业占用） */
  locks: ZoneLock[];
  /** 历次闭池档案（不可变快照，按时间顺序） */
  closureIds: string[];
  /** 当前生效中的闭池档案 id；恢复开放后清空（历史仍在 closureIds） */
  activeClosureId?: string;
  createdAt: string;
}

export type LockReason = 'institution_rental' | 'coaching' | 'maintenance' | 'private_event';

export interface ZoneLock {
  id: string;
  zoneId: ZoneId;
  lane?: number;          // 不传 = 整个泳区
  reason: LockReason;
  title: string;          // 如「蓝鲸游泳培训机构·少儿提高班」
  contactName: string;
  contactPhone: string;
  capacity: number;       // 占用名额
  isCommercial: boolean;  // 商业 vs 居民公益
  bookingId?: string;
}

/** 水质检测 */
export interface WaterReading {
  id: string;
  sessionId: string;
  at: string;
  tempC: number;          // 水温
  freeChlorine: number;   // 余氯 mg/L
  turbidity: number;      // 浊度 NTU
  ph: number;
  recorder: string;       // 记录人
  /** 自动/人工判定 */
  abnormal: boolean;
  abnormalFields: string[];
  note?: string;
  eventId?: string;
}

/** 设备状态 */
export type EquipmentStatus = 'normal' | 'warning' | 'fault';
export interface Equipment {
  id: string;
  name: string;            // 循环泵 / 加氯机 / 除湿机 / AED / 监控
  zoneId: ZoneId | 'all';
  status: EquipmentStatus;
  lastCheck: string;
  note?: string;
}

/** 救生员站位与巡查 */
export type GuardPost = 'tower_deep' | 'tower_shallow' | 'family_patrol' | 'shower' | 'roaming';
export const GUARD_POST_LABEL: Record<GuardPost, string> = {
  tower_deep: '深水区瞭望台',
  tower_shallow: '浅水区瞭望台',
  family_patrol: '儿童区巡逻',
  shower: '淋浴区岗',
  roaming: '机动巡视',
};

export interface GuardDuty {
  id: string;
  sessionId: string;
  guardUserId: string;
  post: GuardPost;
  start: string;
  end?: string;
  relief?: string;         // 换岗接班人
  note?: string;
}

/** 运营巡查记录 */
export type PatrolIssueType =
  | 'diving'          // 泳客违规跳水
  | 'child_alone'     // 儿童离开陪同人
  | 'wet_floor'       // 地面湿滑
  | 'shower_crowd'    // 淋浴区拥堵
  | 'water_quality'   // 水质检测异常
  | 'guard_missing'   // 救生员脱岗
  | 'other';

export type IssueSeverity = 'minor' | 'major' | 'critical';
export type IssueStatus = 'open' | 'handling' | 'resolved';

export interface PatrolIssue {
  id: string;
  sessionId: string;
  at: string;
  type: PatrolIssueType;
  severity: IssueSeverity;
  description: string;
  location: string;
  reporter: string;
  /** 分派给的岗位/角色 */
  assigneeRole?: Role;
  assigneeName?: string;
  status: IssueStatus;
  resolution?: string;
  resolvedAt?: string;
  eventId?: string;
}

/** 跨角色协同事件 */
export type IncidentType =
  | 'water_abnormal'   // 水质异常
  | 'thunderstorm'     // 雷雨临近
  | 'cramp'            // 泳客抽筋
  | 'child_lost'       // 儿童走失
  | 'locker_dispute'   // 储物柜纠纷
  | 'overbooking'      // 预约超额
  | 'equipment_fault'  // 设备故障
  | 'medical';         // 其他医疗急救

export type IncidentSeverity = 'major' | 'critical';
export type IncidentStatus = 'open' | 'responding' | 'resolved';

export interface IncidentAction {
  id: string;
  at: string;
  by: string;
  byRole: Role;
  content: string;
}

export interface Incident {
  id: string;
  code: string;
  sessionId: string;
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  reportedAt: string;
  reporter: string;
  status: IncidentStatus;
  /** 协同角色与处置要求 */
  tasks: IncidentTask[];
  actions: IncidentAction[];
  resolvedAt?: string;
}

export interface IncidentTask {
  id: string;
  role: Role;
  content: string;
  done: boolean;
  doneBy?: string;
  doneAt?: string;
}

export type TaskKind = 'cleaning' | 'maintenance' | 'disinfection';
export type WorkTaskStatus = 'pending' | 'in_progress' | 'done';

export interface WorkTask {
  id: string;
  sessionId?: string;
  kind: TaskKind;
  title: string;
  detail: string;
  zoneId?: ZoneId | 'all';
  assigneeRole: 'cleaner' | 'maintenance';
  assigneeName?: string;
  status: WorkTaskStatus;
  createdAt: string;
  doneAt?: string;
  result?: string;
  source?: 'routine' | 'incident' | 'patrol' | 'closure';
  incidentId?: string;
  /** 闭池联动生成时，引用不可变闭池档案 id */
  closureId?: string;
}

export interface Complaint {
  id: string;
  userId: string;
  at: string;
  category: '水质' | '拥挤' | '救生服务' | '储物柜' | '教练课' | '卫生' | '其他';
  content: string;
  status: 'open' | 'replied';
  reply?: string;
  repliedAt?: string;
}

export interface Notification {
  id: string;
  at: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  /** 目标角色；空数组 = 全体居民可见 */
  roles: Role[];
  userId?: string;       // 个人通知（退费/补偿）
  sessionId?: string;
  /** 引用触发该通知的闭池档案（不可变） */
  closureId?: string;
}

// ============ 闭池处置档案（不可变快照，同场次可多次闭池） ============
export interface ClosureAffectedItem {
  bookingId: string;
  bookingCode: string;
  userId: string;
  userName?: string;
  paidAmount: number;
  paymentMethod: Booking['paymentMethod'];
  refunded: boolean;
  voucherGranted: boolean;
  /** 该居民收到的逐人通知 id */
  notificationId?: string;
}

export type ClosureStatus = 'closed' | 'reopened';

export interface ClosureRecord {
  id: string;
  /** 同一场次第几次闭池，从 1 开始 */
  seq: number;
  sessionId: string;
  sessionLabel: string;
  cause: IncidentType | 'other';
  /** 闭池原因原文（雷雨/水质…），固化后不再被后续状态覆盖 */
  reason: string;
  closedAt: string;
  closedBy: string;
  status: ClosureStatus;
  requireWaterRetest: boolean;
  options: { refund: boolean; compVoucher: boolean; notifyResidents: boolean };
  /** 受影响预约与逐人退费/补偿结果快照 */
  affected: ClosureAffectedItem[];
  refundTotal: number;
  refundCount: number;
  voucherCount: number;
  /** 全员公告 + 岗位通知 id */
  announcementIds: string[];
  /** 撤哨救生员人数 */
  guardReliefCount: number;
  /** 联动生成的消毒复测 / 清场工单 id */
  taskIds: string[];
  /** 关联协同事件 id */
  incidentIds: string[];
  reopenedAt?: string;
  reopenedBy?: string;
  /** 恢复开放所依据的达标复测读数 id */
  retestReadingId?: string;
  reopenNote?: string;
  /** 恢复时实际送达的通知 id（回写同一轮档案） */
  reopenNotificationIds?: string[];
  /** 恢复门禁核验快照：恢复瞬间固化各项处置完成结果，之后不再变化 */
  reopenChecklist?: {
    cleaning: ClosureTaskResult | null;
    disinfection: ClosureTaskResult | null;
    /** 必要时（requireWaterRetest）的达标水质记录快照；不需要时为 null */
    water: ClosureWaterResult | null;
  };
}

/** 闭池联动工单的完成结果快照 */
export interface ClosureTaskResult {
  taskId: string;
  title: string;
  kind: TaskKind;
  assigneeRole: 'cleaner' | 'maintenance';
  assigneeName?: string;
  doneAt: string;
  result?: string;
}

/** 恢复开放所依据的达标水质复测快照 */
export interface ClosureWaterResult {
  readingId: string;
  at: string;
  recorder: string;
  tempC: number;
  freeChlorine: number;
  turbidity: number;
  ph: number;
}

/** 钱包流水 */
export interface WalletTxn {
  id: string;
  at: string;
  userId: string;
  amount: number;         // 正=充值/退费，负=消费
  reason: string;
  sessionId?: string;
  /** 引用产生该退费的闭池档案（第几轮闭池不可变） */
  closureId?: string;
}

/** 教练课 */
export interface CoachingLesson {
  id: string;
  coachName: string;
  title: string;             // 少儿启蒙/自由泳提高
  sessionId: string;
  zoneId: ZoneId;
  lane: number;
  capacity: number;
  enrolled: number;
  price: number;
  studentIds: string[];
}

/** 实时看板（救生员端 + 运营） */
export interface ZoneLiveStat {
  zoneId: ZoneId;
  name: string;
  capacity: number;
  inPool: number;
  booked: number;
  children: number;
  locked: number;           // 被商业/包场占用名额
  deepCertRequired: boolean;
  deepCertHoldersInPool: number;
  occupancyPct: number;
}

export interface LiveBoard {
  session: Session;
  zones: ZoneLiveStat[];
  totalInPool: number;
  totalCapacity: number;
  water: WaterReading | null;
  openIncidents: Incident[];
  guardOnDuty: { post: GuardPost; postLabel: string; guardName: string; startedAt: string }[];
  poolStatus: PoolStatus;
  thunderAlert: boolean;
  equipment: Equipment[];
}

export interface DB {
  users: User[];
  zones: Zone[];
  sessions: Session[];
  bookings: Booking[];
  waterReadings: WaterReading[];
  equipment: Equipment[];
  guardDuties: GuardDuty[];
  patrolIssues: PatrolIssue[];
  incidents: Incident[];
  workTasks: WorkTask[];
  complaints: Complaint[];
  notifications: Notification[];
  walletTxns: WalletTxn[];
  lessons: CoachingLesson[];
  /** 全部场次的闭池处置档案（不可变快照） */
  closureRecords: ClosureRecord[];
  counters: Record<string, number>;
  seededAt: string;
}

// ============ API 请求/响应 ============

export interface LoginReq { username: string; password: string; }
export interface LoginResp { user: User; token: string; }

export interface CreateBookingReq {
  kind: BookingKind;
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;
  age: number;
  healthPledge: boolean;
  healthCode?: 'green' | 'expired' | 'none';
  medicalCert?: boolean;
  withChildren: boolean;
  childCount: number;
  childCompanion?: string;
  childCompanionPhone?: string;
  swimLevel: SwimLevel;
  partySize?: number;
  childrenInParty?: number;
  contactName?: string;
  contactPhone?: string;
  orgName?: string;
  paymentMethod?: 'wallet' | 'cash' | 'voucher';
}

export interface CheckInReq {
  bookingId: string;
  healthCode: 'green' | 'expired' | 'none';
  medicalCert: boolean;
  childCompanion: string;
  childCompanionPhone: string;
  lockerNo: string;
}

export interface WaterReadingReq {
  sessionId: string;
  tempC: number;
  freeChlorine: number;
  turbidity: number;
  ph: number;
  note?: string;
}

export interface PatrolReq {
  sessionId: string;
  type: PatrolIssueType;
  severity: IssueSeverity;
  description: string;
  location: string;
  assigneeRole?: Role;
}

export interface IncidentCreateReq {
  sessionId: string;
  type: IncidentType;
  severity?: IncidentSeverity;
  title: string;
  description: string;
}

export interface IncidentActionReq { content: string; }
export interface IncidentTaskDoneReq { taskId: string; }

export interface PoolStatusReq {
  sessionId: string;
  status: PoolStatus;
  reason?: string;
  cause?: IncidentType | 'other';
  /** 闭池时联动：退费、发补偿券、复测、清场巡查、居民通知 */
  refund?: boolean;
  compVoucher?: boolean;
  notifyResidents?: boolean;
  requireWaterRetest?: boolean;
}

export interface WorkTaskReq {
  sessionId?: string;
  kind: TaskKind;
  title: string;
  detail: string;
  zoneId?: ZoneId | 'all';
  assigneeRole: 'cleaner' | 'maintenance';
}

export interface ComplaintReq {
  category: Complaint['category'];
  content: string;
}

export interface RechargeReq { amount: number; }

export interface LessonEnrollReq { lessonId: string; }

export interface GuardDutyReq {
  sessionId: string;
  post: GuardPost;
}

export interface GuardReliefReq {
  dutyId: string;
  relief: string;
  note?: string;
}

export interface LockReq {
  sessionId: string;
  zoneId: ZoneId;
  lane?: number;
  reason: LockReason;
  title: string;
  contactName: string;
  contactPhone: string;
  capacity: number;
  isCommercial: boolean;
}

export interface Me {
  user: User;
  zoneConflicts: { sessionId: string; sessionLabel: string; message: string }[];
}

// ============ 服务端按角色裁剪后的状态视图（/api/state） ============
/** 对外最小人员卡片：绝不含余额、补偿券、密码、年龄等 PII */
export interface PatronCard {
  id: string;
  name: string;
  role: Role;
  phone?: string;
  memberTier?: MemberTier;
  deepCert?: boolean;
}

export interface StateView {
  viewerRole: Role;
  users: PatronCard[];
  zones: Zone[];
  sessions: Session[];
  bookings: Booking[];
  waterReadings: WaterReading[];
  equipment: Equipment[];
  guardDuties: GuardDuty[];
  patrolIssues: PatrolIssue[];
  incidents: Incident[];
  workTasks: WorkTask[];
  complaints: Complaint[];
  notifications: Notification[];
  walletTxns: WalletTxn[];
  lessons: CoachingLesson[];
  /** 闭池处置档案：ops 全量；其他角色为按本人/脱敏裁剪后的快照 */
  closureRecords: ClosureRecord[];
  boards: LiveBoard[];
  conflicts: { sessionId: string; sessionLabel: string; message: string }[];
}
